#!/usr/bin/env bash
# Installs (or updates) the status line and points Claude Code's settings at it.
#
#   curl -fsSL https://raw.githubusercontent.com/BumaldaOverTheWater94/claudeCodeStatusline/master/install.sh | bash
#
# Environment overrides:
#   STATUSLINE_DIR     install location (default: <claude config dir>/statusline)
#   CLAUDE_CONFIG_DIR  Claude Code config dir (default: ~/.claude)
#   STATUSLINE_REPO    git URL to clone from
#   STATUSLINE_REF     branch to install (default: master)

# Everything runs inside main, so a partially downloaded script does nothing.
main() {
  set -euo pipefail

  local repo="${STATUSLINE_REPO:-https://github.com/BumaldaOverTheWater94/claudeCodeStatusline.git}"
  local ref="${STATUSLINE_REF:-master}"
  local config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local dir="${STATUSLINE_DIR:-$config_dir/statusline}"
  local settings="$config_dir/settings.json"

  say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
  die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

  # --- requirements ---
  command -v node >/dev/null 2>&1 || die "Node.js 18+ is required (https://nodejs.org)"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' ||
    die "Node.js 18+ is required (found $(node --version))"
  if [ -s "$settings" ]; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$settings" 2>/dev/null ||
      die "$settings isn't valid JSON; fix it and re-run"
  fi

  # --- download or update ---
  if [ -d "$dir/.git" ]; then
    say "Updating $dir"
    git -C "$dir" pull --ff-only --quiet
  elif [ -e "$dir" ] && [ ! -f "$dir/src/ctx_monitor.js" ] && [ -n "$(ls -A "$dir")" ]; then
    die "$dir already exists and isn't this status line. Move it aside or set STATUSLINE_DIR."
  elif command -v git >/dev/null 2>&1 && [ ! -e "$dir/src/ctx_monitor.js" ]; then
    say "Cloning into $dir"
    git clone --quiet --depth 1 --branch "$ref" "$repo" "$dir"
  else
    # No git (or an earlier tarball install): download the branch and unpack it
    # over the install dir. Runtime files in cache/ aren't in the tarball, so
    # they're kept.
    command -v curl >/dev/null 2>&1 || die "git or curl is required"
    local slug
    slug="$(printf '%s' "$repo" | sed -E 's#^(https://|git@)github\.com[:/]##; s#\.git$##')"
    say "Downloading $slug@$ref into $dir"
    mkdir -p "$dir"
    curl -fsSL "https://codeload.github.com/$slug/tar.gz/refs/heads/$ref" |
      tar -xz --strip-components=1 -C "$dir"
  fi

  # --- settings.json ---
  # Set statusLine to run the installed script, keeping every other setting.
  # The previous settings.json is backed up whenever it changes.
  mkdir -p "$config_dir"
  node - "$settings" "node \"$dir/src/ctx_monitor.js\"" <<'EOF'
const fs = require("fs");
const [file, command] = process.argv.slice(2);
let text = "{}";
try {
  text = fs.readFileSync(file, "utf8");
} catch {
  // no settings yet
}
let settings;
try {
  settings = JSON.parse(text.trim() || "{}");
} catch (e) {
  console.error(`error: can't parse ${file} (${e.message}); add the statusLine setting by hand`);
  process.exit(1);
}
if (settings.statusLine?.command === command) {
  console.log(`\x1b[36m==>\x1b[0m ${file} already uses this status line`);
  process.exit(0);
}
if (fs.existsSync(file)) {
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  console.log(`\x1b[36m==>\x1b[0m Backed up ${file} to ${backup}`);
}
if (settings.statusLine) {
  console.log(`\x1b[36m==>\x1b[0m Replacing existing statusLine: ${JSON.stringify(settings.statusLine)}`);
}
settings.statusLine = { type: "command", command, padding: 0 };
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log(`\x1b[36m==>\x1b[0m Set statusLine in ${file}`);
EOF

  # --- prices ---
  say "Fetching Bedrock prices"
  node "$dir/src/bedrock_pricing.js" ||
    say "Couldn't fetch prices now; the status line retries in the background"

  say "Done. Restart Claude Code (or start a new session) to see the status line."
}

main "$@"
