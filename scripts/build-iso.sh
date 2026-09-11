#!/usr/bin/env bash
# =============================================================================
#  NasOS - Open Source NAS Operating System
#  ISO Build Script
#
#  特性:
#    - x86_64 (amd64) 通用内核: 同时兼容 Intel 与 AMD CPU
#      (同时打包 intel-microcode + amd64-microcode, 两家微码都会按需加载)
#    - 可选 arm64 (飞腾/鲲鹏等国产平台)
#    - 双引导: BIOS (isolinux/syslinux) + UEFI (GRUB)
#    - Live 系统 (live-boot) + 内置安装器, 可装入物理机 / 虚拟机 / 磁盘
#
#  用法 (需要 root, 且必须是 Linux 环境或本项目的 Docker 构建镜像):
#    sudo ./scripts/build-iso.sh                # 构建 x86_64
#    sudo ARCH=arm64 ./scripts/build-iso.sh     # 构建 arm64
#
#  推荐 (无需手工准备环境):
#    make iso         # 自动用 Docker 构建
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------- 基本变量 --
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ARCH="${ARCH:-amd64}"                    # amd64 | arm64
SUITE="${SUITE:-bookworm}"               # Debian 12
MIRROR="${MIRROR:-http://deb.debian.org/debian}"
VERSION="${VERSION:-$(tr -d ' \n' < "$PROJECT_ROOT/VERSION" 2>/dev/null || echo "0.1.0")}"

BUILD_DIR="${BUILD_DIR:-$PROJECT_ROOT/build}"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/out}"
ROOTFS="$BUILD_DIR/rootfs"
ISO_DIR="$BUILD_DIR/iso"
ISO_NAME="nasos-${VERSION}-${ARCH}.iso"
ISO_PATH="$OUT_DIR/$ISO_NAME"

# 内核包名随架构变化
case "$ARCH" in
  amd64) KERNEL_PKG="linux-image-amd64";   EFI_PKG="grub-efi-amd64-bin"; EFI_TARGET="x86_64-efi"; EFI_BOOT_FILE="bootx64.efi" ;;
  arm64) KERNEL_PKG="linux-image-arm64";   EFI_PKG="grub-efi-arm64-bin"; EFI_TARGET="arm64-efi";  EFI_BOOT_FILE="bootaa64.efi" ;;
  *) echo "不支持的架构: $ARCH (支持 amd64 / arm64)"; exit 1 ;;
esac

log()  { echo -e "\033[1;32m[NasOS]\033[0m $*"; }
warn() { echo -e "\033[1;33m[Warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[Fail]\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------- 依赖检查 --
check_deps() {
  log "检查构建环境..."
  [ "$(id -u)" -eq 0 ] || die "必须以 root 运行 (debootstrap 需要 root)"

  local missing=()
  for t in debootstrap xorriso mksquashfs grub-mkimage mkisofs; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    warn "缺少工具: ${missing[*]}"
    log "尝试自动安装..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq \
      debootstrap xorriso squashfs-tools grub-common grub-pc-bin \
      grub-common grub-pc-bin "grub-efi-${ARCH}-bin" mtools dosfstools \
      isolinux syslinux-common qemu-utils
  fi

  # live 系统需要能挂载 proc/sys/dev
  [ -d /proc/self ] || die "需要可用的 /proc"
  log "构建环境就绪"
}

# ---------------------------------------------------------- 1. 生成 rootfs --
build_rootfs() {
  log "1/6 生成基础系统 (debootstrap $SUITE/$ARCH)..."
  rm -rf "$ROOTFS"
  mkdir -p "$ROOTFS"

  debootstrap \
    --arch="$ARCH" \
    --variant=minbase \
    --include="ca-certificates,curl,wget,gnupg,locales,sudo,iproute2,procps" \
    "$SUITE" "$ROOTFS" "$MIRROR" \
    || die "debootstrap 失败，请检查网络与镜像源"

  log "基础系统就绪: $(du -sh "$ROOTFS" | cut -f1)"
}

# --------------------------------------------------- 2. chroot 内配置系统 --
configure_rootfs() {
  log "2/6 配置系统并安装 NasOS 组件 (约 5-15 分钟)..."

  # 准备 chroot 所需的虚拟文件系统
  mount -t proc  /proc "$ROOTFS/proc" 2>/dev/null || true
  mount -t sysfs /sys  "$ROOTFS/sys"  2>/dev/null || true
  mount --bind   /dev  "$ROOTFS/dev"  2>/dev/null || true
  mount --bind   /dev/pts "$ROOTFS/dev/pts" 2>/dev/null || true

  # 把项目里的 rootfs 覆盖层与安装脚本拷进去
  mkdir -p "$ROOTFS/opt/nasos"
  cp -r "$PROJECT_ROOT/rootfs/." "$ROOTFS/" 2>/dev/null || true
  cp -r "$PROJECT_ROOT/VERSION"  "$ROOTFS/opt/nasos/VERSION" 2>/dev/null || true

  # chroot 配置脚本放到 rootfs 内执行
  cp "$SCRIPT_DIR/chroot-setup.sh" "$ROOTFS/tmp/chroot-setup.sh"
  chmod +x "$ROOTFS/tmp/chroot-setup.sh"

  chroot "$ROOTFS" /bin/bash -c \
    "ARCH=$ARCH KERNEL_PKG=$KERNEL_PKG SUITE=$SUITE MIRROR=$MIRROR /tmp/chroot-setup.sh" \
    || die "chroot 配置失败"

  rm -f "$ROOTFS/tmp/chroot-setup.sh"
  log "系统配置完成: $(du -sh "$ROOTFS" | cut -f1)"
}

# ------------------------------------------------------- 3. 清理与收尾 --
cleanup_rootfs() {
  log "3/6 清理系统..."

  # 卸载虚拟文件系统
  for m in dev/pts dev sys proc; do
    umount -l "$ROOTFS/$m" 2>/dev/null || true
  done

  chroot "$ROOTFS" /bin/bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get clean
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
    rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
    rm -f /root/.bash_history 2>/dev/null || true
    # 清空 machine-id, 让每台机器首次启动生成自己的
    : > /etc/machine-id
    : > /var/lib/dbus/machine-id 2>/dev/null || true
  " 2>/dev/null || true
}

# ---------------------------------------------------- 4. 打包 squashfs --
make_squashfs() {
  log "4/6 打包文件系统 (squashfs)..."
  mkdir -p "$ISO_DIR/live"
  rm -f "$ISO_DIR/live/filesystem.squashfs"

  mksquashfs "$ROOTFS" "$ISO_DIR/live/filesystem.squashfs" \
    -comp xz -Xbcj x86 -b 1M -noappend -processors 0 \
    -e boot \
    || die "mksquashfs 失败"

  log "squashfs: $(du -sh "$ISO_DIR/live/filesystem.squashfs" | cut -f1)"
}

# --------------------------------------------- 5. 组装引导 (BIOS + UEFI) --
make_bootloader() {
  log "5/6 组装引导程序 (BIOS + UEFI)..."

  # 拷出内核与 initrd
  local kver
  kver=$(ls "$ROOTFS/boot" | grep -m1 '^vmlinuz-' | sed 's/^vmlinuz-//')
  [ -n "$kver" ] || die "未找到内核镜像"
  cp "$ROOTFS/boot/vmlinuz-$kver" "$ISO_DIR/live/vmlinuz"
  cp "$ROOTFS/boot/initrd.img-$kver" "$ISO_DIR/live/initrd"
  echo "$kver" > "$ISO_DIR/live/.kver"
  log "内核: $kver"

  # ---------------- BIOS: isolinux ----------------
  mkdir -p "$ISO_DIR/isolinux"
  cp /usr/lib/ISOLINUX/isolinux.bin      "$ISO_DIR/isolinux/" 2>/dev/null || \
  cp /usr/lib/syslinux/modules/bios/isolinux.bin "$ISO_DIR/isolinux/" 2>/dev/null || \
    warn "未找到 isolinux.bin, BIOS 引导可能不可用"
  cp /usr/lib/syslinux/modules/bios/ldlinux.c32 "$ISO_DIR/isolinux/" 2>/dev/null || true
  cp /usr/lib/syslinux/modules/bios/libcom32.c32 "$ISO_DIR/isolinux/" 2>/dev/null || true
  cp /usr/lib/syslinux/modules/bios/libutil.c32 "$ISO_DIR/isolinux/" 2>/dev/null || true
  cp /usr/lib/syslinux/modules/bios/vesamenu.c32 "$ISO_DIR/isolinux/" 2>/dev/null || true

  # ---------------- UEFI: GRUB ----------------
  mkdir -p "$ISO_DIR/boot/grub" "$ISO_DIR/EFI/BOOT"
  grub-mkimage \
    -O "$EFI_TARGET" \
    -o "$ISO_DIR/EFI/BOOT/$EFI_BOOT_FILE" \
    -p "/boot/grub" \
    \
    part_gpt part_msdos fat ext2 normal configfile linux search search_fs_uuid \
    iso9660 loopback echo cat test true help gfxterm all_video video efi_gop efi_uga

  # ---------------- BIOS 用的 GRUB (el torito) ----------------
  mkdir -p "$ISO_DIR/boot/grub/i386-pc"
  if command -v grub-mkimage >/dev/null; then
    grub-mkimage \
      -O i386-pc \
      -o "$ISO_DIR/boot/grub/i386-pc/eltorito.img" \
      -p "/boot/grub" \
      \
      biosdisk part_msdos part_gpt fat ext2 iso9660 normal configfile linux search \
      echo cat test true help gfxterm all_video video vbe vga 2>/dev/null || \
      warn "BIOS GRUB 镜像生成失败 (isolinux 仍可用)"
  fi

  # ---------------- 引导菜单 ----------------
  cat > "$ISO_DIR/boot/grub/grub.cfg" <<'GRUBCFG'
set default=0
set timeout=10
set gfxmode=auto
insmod all_video
insmod gfxterm
terminal_output gfxterm

menuentry "NasOS Live (启动体验, 不改动硬盘)" {
    linux /live/vmlinuz boot=live components quiet splash noswap
    initrd /live/initrd
}

menuentry "NasOS Live (安全模式 / 无显卡驱动)" {
    linux /live/vmlinuz boot=live components noapic nolapic nomodeset
    initrd /live/initrd
}

menuentry "NasOS 安装到本机硬盘" {
    linux /live/vmlinuz boot=live components quiet nasos-install
    initrd /live/initrd
}

menuentry "内存检测 (memtest)" {
    linux16 /live/memtest
}
GRUBCFG

  cat > "$ISO_DIR/isolinux/isolinux.cfg" <<'ISOCFG'
DEFAULT vesamenu.c32
TIMEOUT 100
PROMPT 0
MENU TITLE NasOS - Open Source NAS Operating System

LABEL live
  MENU LABEL NasOS Live (启动体验, 不改动硬盘)
  KERNEL /live/vmlinuz
  APPEND initrd=/live/initrd boot=live components quiet splash noswap

LABEL safe
  MENU LABEL NasOS Live (安全模式)
  KERNEL /live/vmlinuz
  APPEND initrd=/live/initrd boot=live components noapic nolapic nomodeset

LABEL install
  MENU LABEL NasOS 安装到本机硬盘
  KERNEL /live/vmlinuz
  APPEND initrd=/live/initrd boot=live components quiet nasos-install
ISOCFG

  # GRUB 主题文件 (背景/字体可选)
  cat > "$ISO_DIR/boot/grub/theme.txt" <<'THEME'
title-text: "NasOS"
desktop-image: "background.png"
+ label { text = "NasOS Live" }
THEME
}

# ------------------------------------------------------- 6. 生成 ISO 镜像 --
make_iso() {
  log "6/6 生成 ISO 镜像..."
  mkdir -p "$OUT_DIR"
  rm -f "$ISO_PATH"

  xorriso -as mkisofs \
    -iso-level 3 \
    -full-iso9660-filenames \
    -volid "NASOS_${VERSION}" \
    -appid "NasOS" \
    -publisher "NasOS Project" \
    -preparer "NasOS Builder" \
    -eltorito-boot isolinux/isolinux.bin \
    -eltorito-catalog isolinux/boot.cat \
    -no-emul-boot -boot-load-size 4 -boot-info-table \
    -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
    -eltorito-alt-boot \
    -e EFI/BOOT/bootx64.efi \
    -no-emul-boot -isohybrid-gpt-basdat \
    -output "$ISO_PATH" \
    "$ISO_DIR" 2>/dev/null \
  || xorriso -as mkisofs \
    -iso-level 3 \
    -full-iso9660-filenames \
    -volid "NASOS_${VERSION}" \
    -eltorito-boot isolinux/isolinux.bin \
    -eltorito-catalog isolinux/boot.cat \
    -no-emul-boot -boot-load-size 4 -boot-info-table \
    -eltorito-alt-boot -e EFI/BOOT/bootx64.efi -no-emul-boot \
    -output "$ISO_PATH" \
    "$ISO_DIR" \
  || die "ISO 生成失败"

  # 计算校验和
  ( cd "$OUT_DIR" && sha256sum "$ISO_NAME" > "$ISO_NAME.sha256" )

  log "=============================================="
  log "构建完成!"
  log "  ISO:      $ISO_PATH"
  log "  大小:     $(du -h "$ISO_PATH" | cut -f1)"
  log "  架构:     $ARCH (Intel/AMD 通用 x86_64)"
  log "  引导:     BIOS + UEFI"
  log "  校验和:   $OUT_DIR/$ISO_NAME.sha256"
  log "=============================================="
}

# ------------------------------------------------------------------ main --
main() {
  log "NasOS $VERSION 构建开始 (arch=$ARCH suite=$SUITE)"
  check_deps
  build_rootfs
  configure_rootfs
  cleanup_rootfs
  make_squashfs
  make_bootloader
  make_iso
}

main "$@"
