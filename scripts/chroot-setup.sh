#!/usr/bin/env bash
# =============================================================================
#  NasOS - chroot 内系统配置脚本
#  由 build-iso.sh 在 rootfs 的 chroot 环境中调用，不需要手工执行。
#
#  关键设计:
#    * CPU 兼容: 安装 x86_64 通用内核 + Intel/AMD 两家微码，
#      同一份 ISO 在 Intel 与 AMD 平台上都能正常启动并加载对应微码。
#    * 存储栈:  mdadm(RAID) + LVM + btrfs/xfs/ext4 + SMART 监控
#    * 共享协议: SMB(Samba) + NFS + FTP + iSCSI + rsync
#    * 容器:    Docker + Compose (应用中心依赖)
#    * 管理端:  NasOS Web (FastAPI + 原生前端)
# =============================================================================
set -euo pipefail

ARCH="${ARCH:-amd64}"
KERNEL_PKG="${KERNEL_PKG:-linux-image-amd64}"
SUITE="${SUITE:-bookworm}"
MIRROR="${MIRROR:-http://deb.debian.org/debian}"
ZFS="${ZFS:-0}"          # ZFS 需要 DKMS 编译，默认关闭，设为 1 开启

export DEBIAN_FRONTEND=noninteractive
export LANG=C.UTF-8

log() { echo -e "\033[1;36m[chroot]\033[0m $*"; }

# ------------------------------------------------------------------ 源配置 --
setup_apt() {
  log "配置 apt 源..."
  cat > /etc/apt/sources.list <<EOF
deb $MIRROR $SUITE main contrib non-free non-free-firmware
deb $MIRROR $SUITE-updates main contrib non-free non-free-firmware
deb http://security.debian.org/debian-security $SUITE-security main contrib non-free non-free-firmware
EOF

  cat > /etc/apt/apt.conf.d/01nasos-norecommends <<'EOF'
APT::Install-Recommends "false";
APT::Install-Suggests "false";
EOF

  apt-get update -qq
}

# ------------------------------------------------------------- 基础系统配置 --
setup_base() {
  log "配置基础系统..."

  echo "nasos" > /etc/hostname
  cat > /etc/hosts <<'EOF'
127.0.0.1       localhost
127.0.1.1       nasos
::1             localhost ip6-localhost ip6-loopback
EOF

  # locale
  sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/apt/../etc/locale.gen 2>/dev/null || true
  printf 'en_US.UTF-8 UTF-8\nzh_CN.UTF-8 UTF-8\n' > /etc/locale.gen
  locale-gen 2>/dev/null || true
  printf 'LANG=en_US.UTF-8\nLC_ALL=en_US.UTF-8\n' > /etc/default/locale

  # 时区 (默认上海，可在 Web 端修改)
  echo "Asia/Shanghai" > /etc/timezone
  ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

  # root 密码: nasos (首次启动强制修改)
  echo 'root:nasos' | chpasswd
  # 允许 root 通过 SSH 登录 (NAS 设备常见做法，Web 端可关闭)
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
}

# ------------------------------------------------- 安装内核 + Intel/AMD 微码 --
install_kernel() {
  log "安装内核与 CPU 微码 (Intel + AMD 双支持)..."

  apt-get install -y -qq \
    "$KERNEL_PKG" \
    firmware-linux firmware-linux-nonfree \
    linux-headers-"${KERNEL_PKG#linux-image-}" 2>/dev/null || \
  apt-get install -y -qq "$KERNEL_PKG" firmware-linux firmware-linux-nonfree

  # ==== 关键: 两家 CPU 的微码都装 ====
  # 启动时 initramfs 会根据实际 CPU 自动加载对应的微码，因此一份 ISO 通吃。
  case "$ARCH" in
    amd64)
      apt-get install -y -qq intel-microcode amd64-microcode || \
        log "微码包安装失败(非致命)，将继续"
      ;;
    arm64)
      apt-get install -y -qq firmware-arm-trusted-firmware 2>/dev/null || true
      ;;
  esac

  # live 系统支持
  apt-get install -y -qq \
    live-boot live-boot-initramfs-tools live-config live-config-systemd \
    initramfs-tools busybox

  log "内核与微码安装完成"
}

# ------------------------------------------------------------ 安装 NAS 组件 --
install_nas_stack() {
  log "安装存储与共享组件..."

  # ---- 存储管理 ----
  apt-get install -y -qq \
    mdadm lvm2 parted gdisk util-linux \
    e2fsprogs xfsprogs btrfs-progs ntfs-3g exfatprogs dosfstools \
    smartmontools hdparm nvme-cli sg3-utils \
    cryptsetup \
    rsync

  # ---- 文件共享协议 ----
  apt-get install -y -qq \
    samba samba-common-bin smbclient \
    nfs-kernel-server nfs-common \
    vsftpd \
    tgt \
    avahi-daemon

  # ---- 网络与系统 ----
  apt-get install -y -qq \
    systemd systemd-sysv dbus \
    iproute2 iputils-ping net-tools \
    openssh-server \
    network-manager \
    ntp chrony \
    lm-sensors \
    htop iotop iftop sysstat \
    curl wget vim-tiny less ncdu tree unzip zip \
    sudo

  # ---- 容器 (应用中心依赖) ----
  apt-get install -y -qq \
    docker.io docker-compose-plugin containerd runc || \
    log "Docker 安装失败(非致命)"

  # ---- 可选 ZFS ----
  if [ "$ZFS" = "1" ]; then
    log "安装 ZFS (DKMS 编译，较慢)..."
    apt-get install -y zfs-dkms zfsutils-linux || log "ZFS 安装失败(非致命)"
  fi

  # ---- Web 管理端运行时 ----
  apt-get install -y -qq \
    python3 python3-pip python3-venv \
    python3-fastapi python3-uvicorn python3-pydantic \
    python3-psutil python3-yaml \
    gunicorn

  log "NAS 组件安装完成"
}

# --------------------------------------------------------- 部署 NasOS 应用 --
deploy_nasos() {
  log "部署 NasOS 管理端..."

  mkdir -p /opt/nasos/{web,backend,data,apps}
  # rootfs 覆盖层已由 build-iso.sh 拷入，这里只做权限与依赖收尾
  chmod -R 755 /opt/nasos
  chmod +x /usr/local/bin/nasos-web \
            /usr/local/sbin/nasos-install \
            /usr/local/sbin/nasos-firstboot 2>/dev/null || true

  # systemd 服务
  cat > /etc/systemd/system/nasos-web.service <<'EOF'
[Unit]
Description=NasOS Web Management Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/nasos-web
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  # 首次启动初始化服务
  cat > /etc/systemd/system/nasos-firstboot.service <<'EOF'
[Unit]
Description=NasOS First Boot Setup
ConditionPathExists=!/opt/nasos/data/.initialized
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nasos-firstboot
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl enable nasos-web.service 2>/dev/null || true
  systemctl enable nasos-firstboot.service 2>/dev/null || true
  systemctl enable smbd nmbd 2>/dev/null || true
  systemctl enable nfs-server 2>/dev/null || true
  systemctl enable ssh 2>/dev/null || true
  systemctl enable docker 2>/dev/null || true
  systemctl enable systemd-networkd 2>/dev/null || true

  # 默认 Samba 配置 (Web 端可覆盖)
  if [ ! -f /etc/samba/smb.conf.nasos ]; then
    mv /etc/samba/smb.conf /etc/samba/smb.conf.nasos 2>/dev/null || true
  fi
  cat > /etc/samba/smb.conf <<'EOF'
[global]
   workgroup = WORKGROUP
   server string = NasOS
   security = user
   map to guest = Bad User
   dns proxy = no
   # 让 macOS / Windows 都能良好兼容
   vfs objects = catia fruit streams_xattr
   fruit:metadata = stream
   fruit:model = NasOS
   ea support = yes

# ==== 以下共享由 NasOS Web 管理端动态生成 ====
include = /etc/samba/smb.conf.nasos-shares
EOF
  touch /etc/samba/smb.conf.nasos-shares

  log "管理端部署完成"
}

# -------------------------------------------------------------- 引导相关 --
setup_boot() {
  log "安装引导程序文件..."
  case "$ARCH" in
    amd64)
      apt-get install -y -qq grub-pc-bin grub-efi-amd64-bin grub-common || true
      apt-get install -y -qq syslinux isolinux syslinux-common || true
      ;;
    arm64)
      apt-get install -y -qq grub-efi-arm64-bin || true
      ;;
  esac

  # 重新生成 initramfs (确保 live-boot 与微码被包含)
  update-initramfs -u -k all 2>/dev/null || log "initramfs 更新失败(非致命)"
}

# -------------------------------------------------------------------- main --
main() {
  setup_apt
  setup_base
  install_kernel
  install_nas_stack
  deploy_nasos
  setup_boot
  log "chroot 配置全部完成"
}

main "$@"
