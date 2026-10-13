#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="claude-flightdeck"
PORT=1337

# ── Colors ────────────────────────────────────────────────────────────────────
BOLD='\033[1m'; RESET='\033[0m'
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'

log()  { echo -e "${BLUE}▸${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
die()  { echo -e "${RED}✗${RESET} $*"; exit 1; }

echo -e "\n${BOLD}◈ Claude Manager — Deploy${RESET}\n"

# ── Require pnpm ─────────────────────────────────────────────────────────────
command -v pnpm &>/dev/null || die "pnpm not found — install it (https://pnpm.io/installation)"

# ── Resolve pm2 ──────────────────────────────────────────────────────────────
if command -v pm2 &>/dev/null; then
  PM2="pm2"
else
  PM2="pnpm dlx pm2"
  log "pm2 not in PATH — using pnpm dlx"
fi

# ── Parse args ────────────────────────────────────────────────────────────────
CMD="${1:-deploy}"   # deploy | stop | restart | status | logs

case "$CMD" in

# ── DEPLOY ───────────────────────────────────────────────────────────────────
deploy)
  # 1. Install deps (pnpm workspace: server + client, lockfile enforced)
  log "Installing dependencies…"
  (cd "$DIR" && pnpm install --frozen-lockfile --silent)
  ok "Dependencies ready"

  # 2. Build client
  log "Building client…"
  (cd "$DIR" && pnpm build 2>&1)
  ok "Client built → client/dist/"

  # 3. Start/restart via pm2
  if $PM2 describe "$APP" &>/dev/null; then
    log "Restarting existing pm2 process…"
    $PM2 restart "$DIR/ecosystem.config.cjs" --update-env
  else
    log "Starting with pm2…"
    $PM2 start "$DIR/ecosystem.config.cjs"
  fi

  # 4. Save pm2 list so it survives reboots
  $PM2 save --force &>/dev/null

  echo ""
  ok "Deployed! Running at ${BOLD}http://localhost:${PORT}${RESET}"

  # 5. Open browser (macOS)
  if command -v open &>/dev/null; then
    sleep 1 && open "http://localhost:${PORT}"
  fi
  ;;

# ── STOP ─────────────────────────────────────────────────────────────────────
stop)
  if $PM2 describe "$APP" &>/dev/null; then
    $PM2 stop "$APP"
    ok "Stopped $APP"
  else
    warn "$APP is not running"
  fi
  ;;

# ── RESTART ──────────────────────────────────────────────────────────────────
restart)
  log "Rebuilding and restarting…"
  "$0" deploy
  ;;

# ── STATUS ───────────────────────────────────────────────────────────────────
status)
  if $PM2 describe "$APP" &>/dev/null; then
    $PM2 show "$APP"
  else
    warn "$APP is not registered with pm2"
  fi
  ;;

# ── LOGS ─────────────────────────────────────────────────────────────────────
logs)
  $PM2 logs "$APP" --lines "${2:-50}"
  ;;

# ── DELETE (full remove) ─────────────────────────────────────────────────────
delete)
  $PM2 delete "$APP" 2>/dev/null || true
  $PM2 save --force &>/dev/null
  ok "Removed $APP from pm2"
  ;;

*)
  echo "Usage: $0 [deploy|stop|restart|status|logs|delete]"
  echo ""
  echo "  deploy   Build client + start/reload server (default)"
  echo "  stop     Stop the server"
  echo "  restart  Rebuild + reload (alias for deploy)"
  echo "  status   Show pm2 process info"
  echo "  logs     Tail logs (optional: number of lines)"
  echo "  delete   Remove from pm2 entirely"
  exit 1
  ;;
esac
