#!/bin/bash
# Bring Talaria up to date on a Mac whose Hermes Desktop connects to a remote backend: pull
# hermes-talaria into ~/Documents/Github Repos/hermes/talaria (cloning it if missing), then copy the device half
# into Hermes Desktop's plugin folder. The backend half lives on the server and is not touched.
#
#   sync-talaria                       from main
#   sync-talaria claude/project-thread-ekvwk9
#                                      a branch that is not merged yet
#   sync-talaria --install             also put this script on your PATH as sync-talaria
#
# A checkout with changes that are not committed is left alone, so nothing of yours is overwritten.

ROOT="${GITHUB_REPOS:-$HOME/Documents/Github Repos}"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
URL="https://github.com/Kaylachuuu/hermes-talaria.git"
INSTALL=""
BRANCH="main"
for arg in "$@"; do
    case "$arg" in
        --install) INSTALL=1 ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) BRANCH="$arg" ;;
    esac
done

command -v git >/dev/null || { echo "Stopped: git is not installed (xcode-select --install)."; exit 1; }
[ -d "$ROOT" ] || { echo "Stopped: no folder at $ROOT."; exit 1; }

if [ -n "$INSTALL" ]; then
    # Next to sync-repos if it is installed, else Homebrew's bin, which is on the PATH and needs no sudo.
    existing="$(command -v sync-repos 2>/dev/null)"
    if [ -n "$existing" ]; then BIN="$(dirname "$existing")"
    elif [ -d /opt/homebrew/bin ]; then BIN=/opt/homebrew/bin
    else BIN=/usr/local/bin; fi
    if install -m 755 "$0" "$BIN/sync-talaria" 2>/dev/null || sudo install -m 755 "$0" "$BIN/sync-talaria"; then
        echo "Installed as $BIN/sync-talaria"
    else
        echo "Stopped: could not write to $BIN."; exit 1
    fi
fi

# Kept at hermes/talaria on both machines; a checkout named hermes-talaria is found too.
FOLDER="$ROOT/hermes/talaria"
[ ! -d "$FOLDER" ] && [ -d "$ROOT/hermes-talaria/.git" ] && FOLDER="$ROOT/hermes-talaria"
mkdir -p "$(dirname "$FOLDER")"

echo "== talaria ($BRANCH)"
if [ -d "$FOLDER/.git" ]; then
    if [ -n "$(git -C "$FOLDER" status --porcelain)" ]; then
        echo "Stopped: $FOLDER has changes that are not committed. Commit or put them aside first."
        exit 1
    fi
    git -C "$FOLDER" fetch -q origin "$BRANCH" &&
        git -C "$FOLDER" checkout -q "$BRANCH" &&
        git -C "$FOLDER" merge --ff-only -q "origin/$BRANCH" || {
            echo "Stopped: could not bring $FOLDER to origin/$BRANCH."
            exit 1
        }
elif [ -e "$FOLDER" ]; then
    echo "Stopped: $FOLDER exists but is not a git checkout. Rename it and run this again to clone a fresh one."
    exit 1
else
    git clone -q --branch "$BRANCH" "$URL" "$FOLDER" || { echo "Stopped: could not clone $URL."; exit 1; }
fi

version="$(sed -n 's/^version:[[:space:]]*//p' "$FOLDER/talaria/plugin.yaml" 2>/dev/null)"
echo "talaria ${version:-?} at $(git -C "$FOLDER" log -1 --format='%h %s')"

SOURCE="$FOLDER/talaria/desktop/plugin.js"
TARGET="$HOME_DIR/desktop-plugins/talaria"
[ -f "$SOURCE" ] || { echo "Stopped: $SOURCE is missing."; exit 1; }
if cmp -s "$SOURCE" "$TARGET/plugin.js"; then
    echo "Desktop plugin already current in $TARGET."
else
    mkdir -p "$TARGET" && cp "$SOURCE" "$TARGET/plugin.js" || { echo "Stopped: could not copy to $TARGET."; exit 1; }
    echo "Desktop plugin updated in $TARGET."
    echo "In Hermes Desktop, press Rescan in Capabilities > Plugins (or restart the app) to load it."
fi
