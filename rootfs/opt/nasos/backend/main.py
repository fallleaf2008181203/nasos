#!/usr/bin/env python3
"""
NasOS Web 管理端 - 后端 API

提供前端所需的全部 REST 接口，真实采集本机状态：
  /api/system   系统信息（CPU 型号、架构、内核、运行时长、引导方式）
  /api/stats    实时指标（CPU / 内存 / 温度 / 网络 / 负载）
  /api/disks    磁盘列表与 SMART 健康
  /api/pools    存储池（mdadm / LVM / 挂载点）
  /api/shares   共享文件夹（SMB / NFS / FTP）
  /api/network  网络接口与地址
  /api/users    用户与用户组
  /api/apps     应用中心（Docker 容器）
  /api/logs     系统日志

设计原则：
  * 任何采集失败都降级为安全默认值，绝不因为缺权限而 500
  * 只读为主；写操作走 /api/action/*，并做白名单校验
"""

import os
import re
import pwd
import grp
import json
import time
import shutil
import socket
import platform
import subprocess
from pathlib import Path
from datetime import datetime

try:
    import psutil
except ImportError:
    psutil = None

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ------------------------------------------------------------------ 配置 --
WEB_DIR = Path(os.environ.get("NASOS_WEB", "/opt/nasos/web"))
DATA_DIR = Path(os.environ.get("NASOS_DATA", "/opt/nasos/data"))
CONF_DIR = Path(os.environ.get("NASOS_CONF", "/etc/nasos"))
SHARES_FILE = CONF_DIR / "shares.json"
APPS_FILE = CONF_DIR / "apps.json"

VERSION = "0.1.0"
try:
    VERSION = (Path("/opt/nasos/VERSION").read_text(encoding="utf-8").strip()
               or VERSION)
except Exception:
    pass

app = FastAPI(title="NasOS", version=VERSION, docs_url="/api/docs")


# ------------------------------------------------------------------ 工具 --
def sh(cmd, timeout=5, default=""):
    """执行 shell 命令，失败返回默认值，绝不抛异常。"""
    try:
        out = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return out.stdout.strip() if out.returncode == 0 else default
    except Exception:
        return default


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def uptime_str():
    try:
        sec = time.time() - psutil.boot_time() if psutil else 0
    except Exception:
        sec = 0
    d, rem = divmod(int(sec), 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    return f"{d} 天 {h} 小时 {m} 分" if d else f"{h} 小时 {m} 分"


# ------------------------------------------------------------- /api/system --
@app.get("/api/system")
def api_system():
    cpu = platform.processor() or ""
    if not cpu:
        for line in Path("/proc/cpuinfo").read_text(
                encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break

    arch = platform.machine()
    # x86_64 内核同时兼容 Intel 与 AMD
    vendor = "Intel / AMD 通用 (x86_64)" if arch == "x86_64" else arch

    return {
        "hostname": socket.gethostname(),
        "version": VERSION,
        "arch": arch,
        "cpu_model": cpu or "未知",
        "cpu_cores": psutil.cpu_count() if psutil else os.cpu_count() or 1,
        "kernel": platform.release(),
        "uptime": uptime_str(),
        "bios": "UEFI" if Path("/sys/firmware/efi").exists() else "Legacy BIOS",
        "cpu_vendor": vendor,
    }


# -------------------------------------------------------------- /api/stats --
@app.get("/api/stats")
def api_stats():
    cpu = psutil.cpu_percent(interval=0.5) if psutil else 0
    mem_pct, mem_total = 0, 0
    if psutil:
        vm = psutil.virtual_memory()
        mem_pct, mem_total = vm.percent, round(vm.total / 1024 ** 3)

    # 磁盘使用率：取所有真实挂载点加权
    disk_pct = 0
    if psutil:
        try:
            parts = [p for p in psutil.disk_partitions()
                     if p.fstype in ("ext4", "xfs", "btrfs", "zfs")
                     and p.mountpoint.startswith("/mnt")]
            usages = []
            for p in parts:
                try:
                    usages.append(psutil.disk_usage(p.mountpoint).percent)
                except Exception:
                    pass
            disk_pct = round(sum(usages) / len(usages)) if usages else 0
        except Exception:
            pass

    # 网络速率
    rx = tx = 0.0
    if psutil:
        try:
            c1 = psutil.net_io_counters()
            time.sleep(0.4)
            c2 = psutil.net_io_counters()
            rx = round((c2.bytes_recv - c1.bytes_recv) / 1024 / 1024 * 2.5, 1)
            tx = round((c2.bytes_sent - c1.bytes_sent) / 1024 / 1024 * 2.5, 1)
        except Exception:
            pass

    # 温度
    temp = 0
    if psutil:
        try:
            temps = psutil.sensors_temperatures()
            vals = [t.current for k, v in temps.items()
                    for t in v if t.current]
            if vals:
                temp = round(max(vals))
        except Exception:
            pass
    if not temp:
        raw = sh("cat /sys/class/thermal/thermal_zone0/temp")
        if raw.isdigit():
            temp = round(int(raw) / 1000)

    load = round(os.getloadavg()[0], 2) if hasattr(os, "getloadavg") else 0

    return {
        "cpu": round(cpu), "mem": round(mem_pct), "mem_total_gb": mem_total,
        "disk": disk_pct, "temp": temp,
        "net_rx": rx, "net_tx": tx, "load": load,
    }


# -------------------------------------------------------------- /api/disks --
@app.get("/api/disks")
def api_disks():
    disks = []
    # lsblk 输出：NAME,SIZE,MODEL,TYPE,SERIAL
    out = sh('lsblk -dno NAME,SIZE,MODEL,SERIAL,TYPE 2>/dev/null')
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 2:
            continue
        name = parts[0]
        size = parts[1]
        model = parts[2] if len(parts) > 2 else "未知"
        serial = parts[3] if len(parts) > 3 else "—"
        dtype = "NVMe" if name.startswith("nvme") else (
            "SSD" if sh(f"cat /sys/block/{name}/queue/rotational") == "0" else "HDD")

        dev = f"/dev/{name}"
        # SMART 温度与健康
        temp, health, smart = 0, "OK", "通过"
        smart_raw = sh(f"smartctl -H -A {dev} 2>/dev/null", timeout=6)
        if smart_raw:
            m = re.search(r"Temperature_Celsius\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)", smart_raw)
            if not m:
                m = re.search(r"Current Temperature:\s+(\d+)", smart_raw)
            if m:
                temp = int(m.group(1))
            if "PASSED" in smart_raw or "OK" in smart_raw:
                health, smart = "OK", "通过"
            else:
                health, smart = "WARN", "未通过"
            m = re.search(r"Reallocated_Sector_Ct\D+(\d+)", smart_raw)
            if m and int(m.group(1)) > 0:
                health, smart = "WARN", f"{m.group(1)} 个重映射扇区"

        # 所属存储池（挂载点）
        pool = "-"
        for p in read_json(CONF_DIR / "pools.json", []):
            pass
        mount = sh(f"lsblk -no MOUNTPOINT {dev} 2>/dev/null | head -1")
        if mount:
            pool = mount

        disks.append({
            "dev": dev, "model": model, "size": size, "type": dtype,
            "temp": temp, "health": health, "smart": smart,
            "serial": serial, "pool": pool or "-",
        })

    return disks or []


# -------------------------------------------------------------- /api/pools --
@app.get("/api/pools")
def api_pools():
    pools = []
    # 1) 配置文件中定义的池
    for p in read_json(CONF_DIR / "pools.json", []):
        pools.append(p)

    # 2) 自动发现 /mnt 下的挂载点
    if psutil:
        for part in psutil.disk_partitions():
            if not part.mountpoint.startswith("/mnt"):
                continue
            try:
                usage = psutil.disk_usage(part.mountpoint)
                pools.append({
                    "name": Path(part.mountpoint).name or "root",
                    "raid": "—",
                    "size": f"{usage.total / 1024 ** 4:.1f} TB",
                    "used": usage.percent,
                    "status": "正常" if usage.percent < 85 else "容量告警",
                    "disks": 1,
                    "fs": part.fstype,
                    "mount": part.mountpoint,
                })
            except Exception:
                pass

    # 3) mdadm 阵列
    md = sh("cat /proc/mdstat 2>/dev/null")
    for m in re.finditer(r"^(md\d+)\s*:\s*(\w+)\s+(raid\d+)", md, re.M):
        pools.append({
            "name": m.group(1), "raid": m.group(3).upper(),
            "size": "—", "used": 0, "status": m.group(2),
            "disks": 0, "fs": "—", "mount": f"/dev/{m.group(1)}",
        })

    # 去重
    seen, out = set(), []
    for p in pools:
        if p["name"] not in seen:
            seen.add(p["name"])
            out.append(p)
    return out


# ------------------------------------------------------------- /api/shares --
@app.get("/api/shares")
def api_shares():
    shares = read_json(SHARES_FILE, [])
    if shares:
        return shares
    # 回落：解析 Samba 配置
    out = []
    conf = sh("cat /etc/samba/smb.conf 2>/dev/null")
    for m in re.finditer(r"^\[(.+?)\]$", conf, re.M):
        name = m.group(1)
        if name in ("global", "homes", "printers"):
            continue
        out.append({
            "name": name, "path": "—", "proto": ["SMB"], "users": "—",
            "rw": True, "status": "启用", "size": "—",
        })
    return out


# ------------------------------------------------------------ /api/network --
@app.get("/api/network")
def api_network():
    interfaces = []
    if psutil:
        for name, addrs in psutil.net_if_addrs().items():
            if name == "lo":
                continue
            ipv4 = next((a.address for a in addrs if a.family == socket.AF_INET), "—")
            mask = next((a.netmask for a in addrs if a.family == socket.AF_INET), "")
            mac = next((a.address for a in addrs
                        if hasattr(a, "family") and str(a.family).startswith("AF_PACKET")), "—")
            up = psutil.net_if_stats().get(name)
            state = "已连接" if (up and up.isup and ipv4 != "—") else "未连接"
            interfaces.append({
                "name": name, "type": "以太网", "ip": f"{ipv4}/{_mask_bits(mask)}",
                "mac": mac, "speed": f"{up.speed} Mbps" if up else "—",
                "rx": "—", "tx": "—", "state": state,
            })

    gw = sh("ip route show default 2>/dev/null | awk '{print $3}' | head -1") or "—"
    dns = []
    try:
        for line in Path("/etc/resolv.conf").read_text(
                encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("nameserver"):
                dns.append(line.split()[1])
    except Exception:
        pass

    return {
        "interfaces": interfaces or [
            {"name": "eth0", "type": "以太网", "ip": "—", "mac": "—",
             "speed": "—", "rx": "—", "tx": "—", "state": "未连接"}],
        "gateway": gw,
        "dns": dns or ["—"],
        "hostname": socket.gethostname(),
    }


def _mask_bits(mask):
    try:
        return sum(bin(int(x)).count("1") for x in mask.split("."))
    except Exception:
        return 24


# -------------------------------------------------------------- /api/users --
@app.get("/api/users")
def api_users():
    users = []
    try:
        for u in pwd.getpwent():
            if u.pw_uid >= 1000 and u.pw_uid < 65534:
                users.append({
                    "name": u.pw_name, "uid": u.pw_uid,
                    "group": grp.getgrgid(u.pw_gid).gr_name,
                    "home": u.pw_dir, "shell": u.pw_shell,
                    "status": "启用" if u.pw_shell not in (
                        "/sbin/nologin", "/usr/sbin/nologin", "/bin/false") else "停用",
                    "last": sh(f"lastlog -u {u.pw_name} 2>/dev/null | tail -1 | "
                               f"awk '{{print $4, $5, $6, $7}}'") or "—",
                })
    except Exception:
        pass
    return users


@app.get("/api/groups")
def api_groups():
    groups = []
    try:
        for g in grp.getgrall():
            if 100 <= g.gr_gid < 65534 or g.gr_gid >= 1000:
                groups.append({
                    "name": g.gr_name, "gid": g.gr_gid,
                    "members": len(g.gr_mem),
                    "perm": "系统定义",
                })
    except Exception:
        pass
    return groups


# --------------------------------------------------------------- /api/apps --
@app.get("/api/apps")
def api_apps():
    catalog = read_json(APPS_FILE, {})
    installed = catalog.get("installed", [])
    available = catalog.get("available", [])

    # 自动发现运行中的 Docker 容器，补充到已安装
    if shutil.which("docker"):
        out = sh("docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}'", timeout=6)
        for line in out.splitlines():
            name, image, status = (line.split("|") + ["", ""])[:3]
            if not name:
                continue
            if not any(i.get("id") == name for i in installed):
                installed.append({
                    "id": name, "name": name, "cat": "容器",
                    "icon": name[:1].upper(), "color": "#2496ed",
                    "desc": f"镜像 {image}",
                    "status": "running" if status.lower().startswith("up") else "stopped",
                    "version": image.split(":")[-1] if ":" in image else "latest",
                })
    return {"installed": installed, "available": available}


# --------------------------------------------------------------- /api/logs --
@app.get("/api/logs")
def api_logs():
    logs = []
    # 优先 journalctl
    if shutil.which("journalctl"):
        out = sh("journalctl -n 30 --no-pager -o short-iso 2>/dev/null", timeout=6)
        for line in out.splitlines()[-30:]:
            m = re.match(r"(\S+ \S+)\s+\S+\s+\S+\[?\d*\]?:\s*(.*)", line)
            if m:
                t = m.group(1)[:19].replace("T", " ")
                msg = m.group(2)
                lv = "warn" if re.search(r"warn|error|fail", msg, re.I) else "info"
                logs.append({"t": t, "lv": lv, "msg": msg[:120]})
    if not logs:
        try:
            for line in Path("/var/log/syslog").read_text(
                    encoding="utf-8", errors="ignore").splitlines()[-30:]:
                m = re.match(r"(\w{3}\s+\d+\s+[\d:]+)\s+\S+\s+\S+:\s*(.*)", line)
                if m:
                    logs.append({"t": m.group(1), "lv": "info", "msg": m.group(2)[:120]})
        except Exception:
            pass
    return list(reversed(logs)) or [
        {"t": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
         "lv": "info", "msg": "NasOS 管理端已就绪"}]


# -------------------------------------------------------------- 写操作 ----
class ActionIn(BaseModel):
    action: str
    args: dict = {}


ALLOWED = {"restart", "shutdown", "scan_disks", "smart_test", "docker_start",
           "docker_stop", "docker_restart", "smb_reload", "nfs_reload"}


@app.post("/api/action")
def api_action(a: ActionIn):
    """受限的写操作入口。所有动作走白名单，避免任意命令执行。"""
    if a.action not in ALLOWED:
        raise HTTPException(400, f"不允许的操作: {a.action}")

    CMDS = {
        "restart":      "systemctl reboot",
        "shutdown":     "systemctl poweroff",
        "scan_disks":   "partprobe; lsblk",
        "smart_test":   "for d in /dev/sd?; do smartctl -t short $d; done",
        "docker_start": "systemctl start docker",
        "docker_stop":  "systemctl stop docker",
        "docker_restart": "systemctl restart docker",
        "smb_reload":   "systemctl reload smbd",
        "nfs_reload":   "systemctl reload nfs-server",
    }
    try:
        subprocess.Popen(CMDS[a.action], shell=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"ok": True, "action": a.action}
    except Exception as e:
        raise HTTPException(500, str(e))


# -------------------------------------------------------------- 静态站点 --
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    # 兼容相对路径引用
    @app.get("/style.css")
    def css():
        return FileResponse(WEB_DIR / "style.css")

    @app.get("/app.js")
    def js():
        return FileResponse(WEB_DIR / "app.js")


# ------------------------------------------------------------------ main --
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
