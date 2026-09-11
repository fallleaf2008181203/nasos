# =============================================================================
#  NasOS - Open Source NAS Operating System
# =============================================================================
#  make iso        构建 x86_64 ISO (Intel / AMD 通用)
#  make iso-arm64  构建 arm64 ISO
#  make demo       Docker Compose 启动 NasOS 体验版 (无需构建 ISO)
#  make shell      进入构建环境容器 (调试用)
#  make clean      清理构建产物
# =============================================================================

BUILDER ?= nasos-builder
ARCH    ?= amd64
PWD     := $(shell pwd)

.PHONY: help iso iso-arm64 builder demo shell clean version

help:
	@echo "NasOS 构建入口"
	@echo "  make iso        构建 x86_64 ISO (Intel/AMD 通用)"
	@echo "  make iso-arm64  构建 arm64 ISO"
	@echo "  make demo       Docker Compose 启动体验版"
	@echo "  make shell      进入构建容器"
	@echo "  make clean      清理"

builder:
	docker build -f Dockerfile.build -t $(BUILDER) .

iso: builder
	@mkdir -p out
	docker run --rm --privileged \
		-e ARCH=amd64 \
		-v "$(PWD)/out:/nasos/out" \
		$(BUILDER) ./scripts/build-iso.sh
	@ls -lh out/

iso-arm64: builder
	@mkdir -p out
	docker run --rm --privileged \
		-e ARCH=arm64 \
		-v "$(PWD)/out:/nasos/out" \
		$(BUILDER) ./scripts/build-iso.sh
	@ls -lh out/

demo:
	docker compose up -d
	@echo "NasOS 已启动: http://localhost:8080"

shell: builder
	docker run --rm -it --privileged \
		-v "$(PWD)/out:/nasos/out" \
		--entrypoint /bin/bash $(BUILDER)

clean:
	rm -rf build out
	docker compose down -v 2>/dev/null || true

version:
	@cat VERSION
