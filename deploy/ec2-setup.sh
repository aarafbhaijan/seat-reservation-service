#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 EC2 instance (run as the default `ubuntu` user):
#   curl -fsSL https://raw.githubusercontent.com/aarafbhaijan/seat-reservation-service/main/deploy/ec2-setup.sh | bash
# Safe to re-run: it pulls the latest code and restarts the stack.
set -euo pipefail

REPO_URL="https://github.com/aarafbhaijan/seat-reservation-service.git"
APP_DIR="$HOME/seat-reservation-service"

# 1. Docker (engine + compose plugin) from Docker's official script.
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# 2. 2 GB swap: a t3.small has 2 GB RAM, and image builds + MySQL can briefly need more.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 3. Kernel limits for thousands of concurrent connections.
sudo tee /etc/sysctl.d/99-burst.conf >/dev/null <<'SYSCTL'
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10240 65535
SYSCTL
sudo sysctl --system >/dev/null

# 4. Code.
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# 5. Secrets: generated once, kept in .env (never committed).
if [ ! -f .env ]; then
  PUBLIC_IP=$(curl -fsS https://checkip.amazonaws.com)
  cat > .env <<ENV
SITE_ADDRESS=${PUBLIC_IP//./-}.sslip.io
MYSQL_PASSWORD=$(openssl rand -hex 16)
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_API_KEY=$(openssl rand -hex 16)
DB_POOL_SIZE=20
LOG_LEVEL=info
ENV
  chmod 600 .env
fi

# 6. Start (sudo because the docker group only applies to new login shells).
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

SITE=$(grep '^SITE_ADDRESS=' .env | cut -d= -f2)
echo
echo "Deployed. Give Caddy ~30s to get its certificate, then:"
echo "  curl https://$SITE/readyz"
echo "Admin key (for ./burst.sh): grep ADMIN_API_KEY $APP_DIR/.env"
