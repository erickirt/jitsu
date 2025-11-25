#!/bin/bash
set -e

BULKER_REPO="git@github.com:jitsucom/bulker.git"
BULKER_PREFIX="bulker"
BULKER_BRANCH="main"
TEMP_DIR=$(mktemp -d)
TEMP_REPO="$TEMP_DIR/bulker-temp"

cleanup() {
  echo "Cleaning up temporary directory..."
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting sync from $BULKER_REPO to $BULKER_PREFIX with full history"

# Clone bulker repo to temporary directory
echo "Cloning bulker repository to temporary location..."
git clone --branch "$BULKER_BRANCH" "$BULKER_REPO" "$TEMP_REPO"
cd "$TEMP_REPO"

# Rewrite history to add bulker/ prefix to all paths
echo "Rewriting commit history to add $BULKER_PREFIX/ prefix to all paths..."
git filter-branch -f --prune-empty --index-filter '
  git ls-files -s |
  sed "s~\t\"*~&'"$BULKER_PREFIX"'/~" |
  GIT_INDEX_FILE=$GIT_INDEX_FILE.new git update-index --index-info &&
  if test -f "$GIT_INDEX_FILE.new"; then
    mv "$GIT_INDEX_FILE.new" "$GIT_INDEX_FILE"
  fi
' -- --all

echo "✓ History rewrite completed"

# Go back to main repo
cd - > /dev/null

if [ ! -d "$BULKER_PREFIX" ]; then
  echo "Performing initial import with rewritten history..."

  # Fetch the rewritten history
  git fetch "$TEMP_REPO" "$BULKER_BRANCH"

  # Merge it
  git merge --allow-unrelated-histories -m "Add $BULKER_PREFIX/ from $BULKER_REPO" FETCH_HEAD

  echo "✓ Initial import completed successfully"
else
  echo "Updating existing $BULKER_PREFIX/ directory with new commits..."

  # Fetch the rewritten history
  git fetch "$TEMP_REPO" "$BULKER_BRANCH"

  # Merge it
  git merge --allow-unrelated-histories -m "Update $BULKER_PREFIX/ from $BULKER_REPO" FETCH_HEAD

  echo "✓ Update completed successfully"
fi

echo "✓ Sync process finished successfully"
echo "You can now run: git log $BULKER_PREFIX/bulkerlib/bulker.go"
