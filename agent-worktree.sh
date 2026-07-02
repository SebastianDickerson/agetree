#!/usr/bin/env bash
#
# agent-worktree.sh — per-agent worktrees that are instantly runnable.
# Supports: Lando, Docker Compose (incl. Laravel Sail), Laravel (+Vite),
# Node stacks, generic repos, and git-crypt encrypted secrets.
#
# Usage:
#   ./agent-worktree.sh new <branch> [base]   Create worktree from [base]
#                                             (default: repo's default branch,
#                                              auto-detected — NOT current HEAD)
#   ./agent-worktree.sh run <branch>          Start dev server(s) / stack
#   ./agent-worktree.sh rm <branch>           Tear down containers, remove worktree
#   ./agent-worktree.sh ls                    List worktrees with their ports
#   ./agent-worktree.sh merge <target> [branches...] [--all] [--rm]
#                                             Merge agent branches into <target>
#
# Lando mode: each worktree gets its own app name via .lando.local.yml,
# so URLs are per-worktree (myapp-agent-x.lndo.site) — no port juggling.
#
# Docker mode requires env-driven host ports in your compose file, e.g.:
#   - "${APP_PORT:-8000}:80"   (Laravel Sail already does this)
#
# git-crypt: repos with filter=git-crypt are handled automatically, but the
# MAIN checkout must be unlocked (git-crypt unlock) before creating worktrees.

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
MAIN_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$MAIN_ROOT")"
WORKTREE_DIR="$MAIN_ROOT/../worktrees"   # anchored to repo, not CWD
DEFAULT_BASE="auto"              # "auto" = origin/HEAD → develop/main/master;
                                 # or pin it, e.g. DEFAULT_BASE="develop"
NODE_BASE_PORT=3000
PHP_BASE_PORT=8000
VITE_BASE_PORT=5173
DB_BASE_PORT=3306                # 5432 for postgres
REDIS_BASE_PORT=6379
ENV_FILES=(".env" ".env.local" ".env.development" ".env.development.local")

# ── Detection ────────────────────────────────────────────────────────────
detect_runtime() {
  [ -f "$MAIN_ROOT/.lando.yml" ] && { echo "lando"; return; }
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    [ -f "$MAIN_ROOT/$f" ] && { echo "docker"; return; }
  done
  echo "host"
}

detect_stack() {
  if [ -f "$MAIN_ROOT/artisan" ] && [ -f "$MAIN_ROOT/composer.json" ]; then
    echo "laravel"
  elif [ -f "$MAIN_ROOT/package.json" ]; then
    echo "node"
  else
    echo "generic"
  fi
}

detect_pm() {
  if   [ -f "$MAIN_ROOT/pnpm-lock.yaml" ]; then echo "pnpm"
  elif [ -f "$MAIN_ROOT/bun.lockb" ] || [ -f "$MAIN_ROOT/bun.lock" ]; then echo "bun"
  elif [ -f "$MAIN_ROOT/yarn.lock" ]; then echo "yarn"
  else echo "npm"
  fi
}

gitcrypt_active() {
  git -C "$MAIN_ROOT" grep -qs 'filter=git-crypt' -- '*.gitattributes' 2>/dev/null \
    || grep -qs 'filter=git-crypt' "$MAIN_ROOT/.gitattributes" 2>/dev/null
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"
  else echo "docker compose"
  fi
}

# ── Helpers ──────────────────────────────────────────────────────────────
# Offsets are never reused (max+1), so rm can't cause later port collisions.
next_offset() {
  local max=0 f o
  for f in "$WORKTREE_DIR"/*/.agent-ports; do
    [ -f "$f" ] || continue
    o="$(sed -n 's/.*offset=\([0-9]*\).*/\1/p' "$f")"
    [ -n "$o" ] && [ "$o" -gt "$max" ] && max="$o"
  done
  echo $((max + 1))
}

wt_path() { echo "$WORKTREE_DIR/$1"; }

resolve_wt() {  # branch → its actual worktree path (empty if none)
  git worktree list --porcelain | awk -v b="refs/heads/$1" '
    /^worktree /{wt=substr($0, 10)}
    /^branch /{if (substr($0, 8) == b) print wt}'
}

# Base ref for new branches: explicit arg > DEFAULT_BASE > origin/HEAD >
# local develop/main/master > current HEAD (with a warning).
resolve_base() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  if [ "$DEFAULT_BASE" != "auto" ]; then echo "$DEFAULT_BASE"; return; fi
  local ref
  ref="$(git -C "$MAIN_ROOT" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$ref" ]; then echo "${ref#refs/remotes/}"; return; fi
  local b
  for b in develop main master; do
    git -C "$MAIN_ROOT" show-ref --verify -q "refs/heads/$b" && { echo "$b"; return; }
  done
  echo "HEAD"
}

sanitize_host() {  # lando names become hostnames: lowercase alnum + hyphen only
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g'
}

sanitize() {  # compose project names: lowercase alnum, - and _
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g'
}

set_env() {  # set_env KEY VALUE FILE — replace if present, append if not
  local key="$1" val="$2" file="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "${file}.bak"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

# Runtime artifacts stay out of git without touching the tracked .gitignore.
# info/exclude in the common dir covers all worktrees, so agents running
# `git add -A` never commit them.
exclude_runtime_files() {
  local ex; ex="$(cd "$(git -C "$MAIN_ROOT" rev-parse --git-common-dir)" && pwd)/info/exclude"
  mkdir -p "$(dirname "$ex")"
  local f
  for f in .agent-ports .lando.local.yml; do
    grep -qx "$f" "$ex" 2>/dev/null || echo "$f" >> "$ex"
  done
}

install_node_deps() {  # frozen install if lockfile exists, plain if not
  local pm="$1"
  [ -f package.json ] || return 0
  echo "  installing JS deps with $pm..."
  case "$pm" in
    pnpm) if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi ;;
    bun)  bun install ;;
    yarn) if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi ;;
    npm)  if [ -f package-lock.json ]; then npm ci; else npm install; fi ;;
  esac
}

link_env_files() {
  local f
  for f in "${ENV_FILES[@]}"; do
    if [ -f "$MAIN_ROOT/$f" ] && [ ! -e "$f" ]; then
      ln -s "$MAIN_ROOT/$f" "$f"
      echo "  linked $f"
    fi
  done
}

run_dev_script() {
  local pm="$1" port="$2"
  if [ ! -f package.json ]; then
    echo "No package.json here — nothing to run. (Generic worktree: envs only.)"
    return 0
  fi
  if grep -q '"dev"' package.json; then
    PORT="$port" "$pm" run dev -- --port "$port" 2>/dev/null \
      || PORT="$port" "$pm" run dev
  elif grep -q '"start"' package.json; then
    PORT="$port" "$pm" run start
  else
    echo "No 'dev' or 'start' script in package.json — start it manually."
  fi
}

teardown_containers() {
  local path="$1" runtime; runtime="$(detect_runtime)"
  [ -d "$path" ] || return 0
  if [ "$runtime" = "lando" ]; then
    echo "  destroying lando app for $(basename "$path")..."
    (cd "$path" && lando destroy -y >/dev/null 2>&1) || true
  elif [ "$runtime" = "docker" ]; then
    echo "  stopping containers for $(basename "$path")..."
    (cd "$path" && $(compose_cmd) down --volumes --remove-orphans 2>/dev/null) || true
  fi
}

# Create the worktree. git-crypt repos need special handling: the smudge
# filter runs during checkout, and inside a worktree older git-crypt looks
# for its key in the worktree's private gitdir (.git/worktrees/<name>/)
# instead of the shared common dir → "external filter git-crypt smudge
# failed". Fix: add with --no-checkout, link the key dir into the worktree's
# gitdir, then populate with reset --hard. Harmless no-op on git-crypt ≥0.7.
create_worktree() {
  local path="$1" branch="$2" base="$3"
  local crypt=false
  gitcrypt_active && crypt=true

  if [ "$crypt" = true ]; then
    local common; common="$(cd "$(git -C "$MAIN_ROOT" rev-parse --git-common-dir)" && pwd)"
    if [ ! -f "$common/git-crypt/keys/default" ] && [ ! -d "$common/git-crypt/keys" ]; then
      echo "❌ This repo uses git-crypt but the main checkout is LOCKED."
      echo "   Unlock it first:  cd $MAIN_ROOT && git-crypt unlock [keyfile]"
      exit 1
    fi
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      git worktree add --no-checkout "$path" "$branch"
    else
      git worktree add --no-checkout "$path" -b "$branch" "$base"
    fi
    local wtgit; wtgit="$(git -C "$path" rev-parse --absolute-git-dir)"
    if [ "$wtgit" != "$common" ] && [ ! -e "$wtgit/git-crypt" ]; then
      ln -s "$common/git-crypt" "$wtgit/git-crypt"
    fi
    git -C "$path" reset --hard -q
    echo "  git-crypt: key linked, secrets decrypted"
  else
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      git worktree add "$path" "$branch"
    else
      git worktree add "$path" -b "$branch" "$base"
    fi
  fi
}

# ── new ──────────────────────────────────────────────────────────────────
cmd_new() {
  local branch="$1"
  local base;    base="$(resolve_base "${2:-}")"
  local path;    path="$(wt_path "$branch")"
  local runtime; runtime="$(detect_runtime)"
  local stack;   stack="$(detect_stack)"
  local pm;      pm="$(detect_pm)"
  local offset;  offset="$(next_offset)"

  mkdir -p "$WORKTREE_DIR"
  exclude_runtime_files

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    echo "── Branch '$branch' exists — checking it out (base arg ignored)"
  elif [ "$base" = "HEAD" ]; then
    echo "⚠️  No base given and no default branch found — branching '$branch'"
    echo "   from current HEAD: $(git rev-parse --abbrev-ref HEAD) ($(git rev-parse --short HEAD))"
  else
    echo "── Branching '$branch' from '$base'"
  fi

  create_worktree "$path" "$branch" "$base"
  cd "$path"

  # ── Lando mode ── unique app name → unique *.lndo.site URL, no ports
  if [ "$runtime" = "lando" ]; then
    local project; project="$(sanitize_host "${REPO_NAME}-${branch}")"

    if git ls-files --error-unmatch .lando.local.yml >/dev/null 2>&1; then
      echo "⚠️  .lando.local.yml is TRACKED in this repo — overriding the app"
      echo "   name will dirty the worktree. Consider untracking it."
    fi
    printf 'name: %s\n' "$project" > .lando.local.yml
    echo "  wrote .lando.local.yml (name: $project)"

    if [ -f "$MAIN_ROOT/.env" ] && [ ! -e .env ]; then
      cp "$MAIN_ROOT/.env" .env
      [ "$stack" = "laravel" ] && set_env APP_URL "https://${project}.lndo.site" .env
      echo "  copied .env"
    fi

    install_node_deps "$pm" || echo "  (host install failed — fine, lando has deps)"

    echo "offset=$offset lando=$project" > .agent-ports
    echo ""
    echo "✅ Lando worktree ready: $path"
    echo "   App name: $project"
    echo "   URL:      https://${project}.lndo.site  (after 'run')"

  # ── Docker mode ──
  elif [ "$runtime" = "docker" ]; then
    local app_port=$((PHP_BASE_PORT + offset))
    local vite_port=$((VITE_BASE_PORT + offset))
    local db_port=$((DB_BASE_PORT + offset))
    local redis_port=$((REDIS_BASE_PORT + offset))
    local project; project="$(sanitize "${REPO_NAME}-${branch}")"

    [ -f "$MAIN_ROOT/.env" ] && [ ! -e .env ] && cp "$MAIN_ROOT/.env" .env
    set_env COMPOSE_PROJECT_NAME "$project" .env
    set_env APP_PORT "$app_port" .env
    set_env VITE_PORT "$vite_port" .env
    set_env FORWARD_DB_PORT "$db_port" .env
    set_env FORWARD_REDIS_PORT "$redis_port" .env
    [ "$stack" = "laravel" ] && set_env APP_URL "http://localhost:$app_port" .env
    echo "  wrote .env (project=$project, app=$app_port, vite=$vite_port)"

    install_node_deps "$pm" || echo "  (host install failed — fine, containers have deps)"

    echo "offset=$offset app=$app_port vite=$vite_port db=$db_port" > .agent-ports
    echo ""
    echo "✅ Docker worktree ready: $path"
    echo "   App: http://localhost:$app_port   DB: :$db_port   Redis: :$redis_port"
    echo "   ⚠️  Requires env-driven host ports, e.g. - \"\${APP_PORT:-8000}:80\""

  # ── Host: Laravel ──
  elif [ "$stack" = "laravel" ]; then
    local app_port=$((PHP_BASE_PORT + offset))
    local vite_port=$((VITE_BASE_PORT + offset))

    if [ -f "$MAIN_ROOT/.env" ] && [ ! -e .env ]; then
      cp "$MAIN_ROOT/.env" .env
      set_env APP_URL "http://localhost:$app_port" .env
      echo "  copied .env (APP_URL → :$app_port)"
    fi
    echo "  composer install..."
    composer install --no-interaction --quiet
    install_node_deps "$pm"
    php artisan storage:link >/dev/null 2>&1 || true

    echo "offset=$offset app=$app_port vite=$vite_port" > .agent-ports
    echo ""
    echo "✅ Laravel worktree ready: $path"
    echo "   App: http://localhost:$app_port   Vite HMR: :$vite_port"

  # ── Host: Node ──
  elif [ "$stack" = "node" ]; then
    local app_port=$((NODE_BASE_PORT + offset))
    link_env_files
    install_node_deps "$pm"
    echo "offset=$offset app=$app_port" > .agent-ports
    echo ""
    echo "✅ Node worktree ready: $path"
    echo "   App: http://localhost:$app_port"

  # ── Host: generic ──
  else
    link_env_files
    echo "offset=$offset" > .agent-ports
    echo ""
    echo "✅ Worktree ready: $path (generic — envs linked, no deps to install)"
  fi

  echo ""
  echo "   Start it:  ./agent-worktree.sh run $branch"
}

# ── run ──────────────────────────────────────────────────────────────────
cmd_run() {
  local branch="$1"
  local path; path="$(wt_path "$branch")"
  [ -d "$path" ] || { echo "No worktree at $path"; exit 1; }

  local runtime; runtime="$(detect_runtime)"
  local stack;   stack="$(detect_stack)"
  local pm;      pm="$(detect_pm)"
  cd "$path"

  local app="" vite=""
  # shellcheck disable=SC2046
  [ -f .agent-ports ] && eval $(cat .agent-ports)

  if [ "$runtime" = "lando" ]; then
    lando start
  elif [ "$runtime" = "docker" ]; then
    $(compose_cmd) up
  elif [ "$stack" = "laravel" ]; then
    trap 'kill 0' EXIT
    php artisan serve --port="$app" &
    if [ -f package.json ] && grep -q '"dev"' package.json; then
      "$pm" run dev -- --port="$vite" --strictPort &
    fi
    wait
  else
    run_dev_script "$pm" "${app:-$((NODE_BASE_PORT + 1))}"
  fi
}

# ── rm ───────────────────────────────────────────────────────────────────
cmd_rm() {
  local branch="$1"
  local path; path="$(resolve_wt "$branch")"
  [ -n "$path" ] && [ -d "$path" ] || { echo "No worktree found for branch '$branch'"; exit 1; }

  teardown_containers "$path"
  git worktree remove "$path" --force
  echo "Removed worktree $path"

  read -rp "Delete branch '$branch' too? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    git branch -D "$branch"
    echo "Deleted branch $branch"
  fi
}

# ── merge ────────────────────────────────────────────────────────────────
cmd_merge() {
  local target="" all=false cleanup=false
  local branches=() paths=()

  local arg
  for arg in "$@"; do
    case "$arg" in
      --all) all=true ;;
      --rm)  cleanup=true ;;
      *) if [ -z "$target" ]; then target="$arg"; else branches+=("$arg"); fi ;;
    esac
  done
  [ -n "$target" ] || { echo "Usage: merge <target> [branches...] [--all] [--rm]"; exit 1; }

  local wt_abs=""
  [ -d "$WORKTREE_DIR" ] && wt_abs="$(cd "$WORKTREE_DIR" && pwd)"

  if [ "$all" = true ]; then
    branches=()
    local wt b
    while IFS=$'\t' read -r wt b; do
      [ -n "$b" ] || continue
      [ "$b" = "$target" ] && continue
      case "$wt" in "$wt_abs"/*) ;; *) continue ;; esac
      branches+=("$b"); paths+=("$wt")
    done < <(git worktree list --porcelain | awk '
      /^worktree /{wt=substr($0, 10)}
      /^branch /{b=substr($0, 8); sub("refs/heads/","",b); print wt "\t" b}')
  else
    local b
    for b in "${branches[@]}"; do
      paths+=("$(resolve_wt "$b")")
    done
  fi
  [ "${#branches[@]}" -gt 0 ] || { echo "No agent branches to merge."; exit 1; }

  local dirty=false i
  for i in "${!branches[@]}"; do
    local p="${paths[$i]}"
    if [ -n "$p" ] && [ -d "$p" ] && [ -n "$(git -C "$p" status --porcelain)" ]; then
      echo "❌ Worktree '${branches[$i]}' has uncommitted changes — commit or stash first:"
      git -C "$p" status --short | sed 's/^/     /'
      dirty=true
    fi
  done
  [ "$dirty" = false ] || exit 1

  cd "$MAIN_ROOT"
  if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Main checkout has uncommitted changes — commit or stash before merging."
    exit 1
  fi

  if git show-ref --verify --quiet "refs/heads/$target"; then
    git checkout "$target" || {
      echo "Could not check out '$target' — is it checked out in another worktree?"
      echo "Remove that worktree first: ./agent-worktree.sh rm $target"
      exit 1
    }
  else
    echo "Branch '$target' doesn't exist — creating it from current HEAD."
    git checkout -b "$target"
  fi

  local merged=() merged_paths=()
  for i in "${!branches[@]}"; do
    local b="${branches[$i]}"
    echo ""
    echo "── Merging '$b' into '$target'..."
    if git merge --no-ff --no-edit "$b"; then
      merged+=("$b"); merged_paths+=("${paths[$i]}")
    else
      echo ""
      echo "⚠️  Conflict merging '$b'. Already merged: ${merged[*]:-none}"
      echo "   Note: conflicts under git-crypt paths (e.g. .secrets/**) are binary —"
      echo "   pick a side (git checkout --theirs/--ours <file>) rather than editing."
      echo "   Resolve in $MAIN_ROOT, then:  git add -A && git merge --continue"
      echo "   Re-run:  ./agent-worktree.sh merge $target <remaining branches>"
      echo "   Or abort:  git merge --abort"
      exit 1
    fi
  done

  echo ""
  echo "✅ Merged ${#merged[@]} branch(es) into '$target': ${merged[*]}"
  echo "   Review the result, then:  git push origin $target"

  if [ "$cleanup" = true ]; then
    echo ""
    for i in "${!merged[@]}"; do
      local b="${merged[$i]}" p="${merged_paths[$i]}"
      if [ -n "$p" ] && [ -d "$p" ]; then
        teardown_containers "$p"
        git worktree remove "$p" --force
        git branch -d "$b" 2>/dev/null && echo "   cleaned up: $b (worktree + branch)" \
          || echo "   removed worktree for $b (branch kept — not fully merged?)"
      fi
    done
  fi
}

# ── ls ───────────────────────────────────────────────────────────────────
cmd_ls() {
  printf "%-30s %-45s %s\n" "WORKTREE" "PORTS/APP" "BRANCH"
  git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}' | while read -r wt; do
    [ "$wt" = "$MAIN_ROOT" ] && continue
    ports="$(cat "$wt/.agent-ports" 2>/dev/null || echo "-")"
    branch="$(git -C "$wt" branch --show-current)"
    printf "%-30s %-45s %s\n" "$(basename "$wt")" "$ports" "${branch:-<detached>}"
  done
}

# ── Dispatch ─────────────────────────────────────────────────────────────
case "${1:-}" in
  new)   shift; cmd_new   "$@" ;;
  run)   shift; cmd_run   "$@" ;;
  rm)    shift; cmd_rm    "$@" ;;
  merge) shift; cmd_merge "$@" ;;
  ls)    cmd_ls ;;
  *)     grep '^#' "$0" | head -24 | sed 's/^# \{0,1\}//' ;;
esac
