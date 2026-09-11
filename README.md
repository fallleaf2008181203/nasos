# NasOS

**开源 NAS 操作系统** —— 一个 ISO 装进你的存储设备、台式机、笔记本或虚拟机。

```
x86_64 通用 (Intel / AMD)   ·   BIOS + UEFI 双引导   ·   物理机 / 虚拟机通吃
```

---

## 这是什么

NasOS 是一份可启动、可安装的 Linux 发行版，把任意 x86_64 设备变成一台 NAS：

| 能力 | 说明 |
|---|---|
| **CPU 兼容** | x86_64 通用内核 + **Intel/AMD 双微码**，同一份 ISO 两家平台都能启动 |
| **引导** | BIOS (isolinux) + UEFI (GRUB) 双支持，老机器新机器都能装 |
| **存储** | RAID 0/1/5/6/10 (mdadm) · LVM · btrfs/ext4/xfs · SMART 监控 · (可选 ZFS) |
| **共享** | SMB (Win/Mac/Linux) · NFS · FTP · iSCSI · rsync |
| **应用中心** | Docker 容器化一键部署：Jellyfin / Nextcloud / Immich / qBittorrent / Home Assistant / Ollama… |
| **管理端** | 全中文 Web 控制台 (FastAPI + 原生 JS)，仪表盘/存储池/共享/用户/网络/应用一站管理 |
| **可移植** | 你的台式存储、公司服务器、VMware/VirtualBox/KVM/Hyper-V 虚拟机都能装 |

---

## 快速开始

### 方式一：5 分钟体验版（无需构建 ISO）

任何装有 Docker 的机器上：

```bash
git clone <你的仓库地址> nasos && cd nasos
docker compose up -d
# 浏览器打开 http://localhost:8080  （admin / nasos）
```

### 方式二：构建 ISO（推荐走 GitHub 云端构建）

本机有 Docker 的，本地构建：

```bash
make iso          # 产出 out/nasos-<版本>-amd64.iso
```

没有 Linux 环境 / 不想装 Docker？**推到 GitHub，云端自动构建：**

```bash
git init && git add . && git commit -m "NasOS 0.1.0"
git remote add origin git@github.com:<你的账号>/nasos.git
git push -u origin main

# 打 tag 触发构建并发布 Release：
git tag v0.1.0 && git push origin v0.1.0
```

推送 tag 后，GitHub Actions 会自动：
1. 用 Docker 起构建环境
2. debootstrap 出 Debian 12 rootfs 并装入全套 NAS 组件
3. 打包 squashfs + 双引导，产出 `nasos-0.1.0-amd64.iso`
4. 创建 GitHub Release 并把 ISO 挂上去 —— **直接下载就能用**

> 也可以在仓库 Actions 页面手动 Run workflow，选 `arm64` 可构建国产平台 (飞腾/鲲鹏) 版本。

### 方式三：在 Linux 上裸跑构建脚本

```bash
sudo ./scripts/build-iso.sh              # x86_64
sudo ARCH=arm64 ./scripts/build-iso.sh   # arm64
```

---

## 安装到设备 / 虚拟机

1. 把 ISO 写入 U 盘（或直接挂给虚拟机光驱）：
   ```bash
   # Windows: 用 Rufus / balenaEtcher
   # Linux:   dd if=nasos-*.iso of=/dev/sdX bs=4M status=progress
   ```
2. 从 U 盘/光驱启动，出现菜单：
   - **NasOS Live** —— 先体验，不动硬盘
   - **安装到本机硬盘** —— 运行安装器写入磁盘
3. 安装器自动识别 UEFI / BIOS 并安装对应引导；装完重启。
4. 浏览器访问 `http://<设备IP>:8080`，默认 `admin / nasos`。

> **支持 Intel 与 AMD**：内核为 x86_64 通用构建，镜像内同时携带 `intel-microcode` 与 `amd64-microcode`，启动时按实际 CPU 自动加载对应微码。
> 桌面级（酷睿/锐龙）与服务器级（至强/EPYC）均可。

---

## 项目结构

```
nasos/
├── Dockerfile.build          # ISO 构建环境（一键，免装工具链）
├── Dockerfile.demo           # 体验版镜像（docker compose 用）
├── docker-compose.yml        # 体验版编排
├── Makefile                  # make iso / make demo
├── VERSION
├── scripts/
│   ├── build-iso.sh          # ISO 总装：rootfs→squashfs→双引导→xorriso
│   └── chroot-setup.sh       # chroot 内装内核/微码/存储栈/Web 端
├── .github/workflows/
│   └── build-iso.yml         # 云端自动构建 + Release 发布
└── rootfs/                   # 覆盖层：直接进镜像的文件
    ├── opt/nasos/
    │   ├── web/              # Web 管理端前端（原生 JS，可 file:// 直开）
    │   └── backend/main.py   # FastAPI 后端（真实采集系统数据）
    └── usr/local/
        ├── bin/nasos-web     # Web 服务启动器
        └── sbin/
            ├── nasos-install # 磁盘安装器
            └── nasos-firstboot # 首启初始化
```

---

## 关于 WorkBuddy

WorkBuddy 是**云端服务**（账号体系 + 云端模型），服务端不开源、无法打包进镜像。
NasOS 对它做的是**入口级集成**：应用中心提供 WorkBuddy 快捷入口与部署模板；
若需要完全内网可用的 AI 助手，应用中心内置 **Ollama 本地大模型** 方案（Llama / Qwen 等，数据不出内网）。

---

## 安全须知

- ISO 默认账号 `admin / nasos`，**首次进入后请立即在「系统设置」修改密码**
- 安装器会**清空目标磁盘**，操作前请确认盘符
- Web 端写操作全部走白名单（`/api/action`），不提供任意命令执行

---

## Roadmap

- [ ] Web 端认证体系（JWT + 密码修改）
- [ ] 存储池创建向导（RAID 组盘 UI）
- [ ] 快照与计划任务
- [ ] 系统在线升级 (A/B 分区)
- [ ] ARM64 国产平台适配（飞腾/鲲鹏）

## License

GPL-3.0 —— 自由使用、修改与分发。
