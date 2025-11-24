#!/bin/bash
set -e

BULKER_REPO="git@github.com:jitsucom/bulker.git"
BULKER_PREFIX="bulker"
BULKER_BRANCH="main"

if [ -d "$BULKER_PREFIX" ]; then
  echo "Syncing bulker repository (pulling latest changes)..."
  git subtree pull --prefix="$BULKER_PREFIX" "$BULKER_REPO" "$BULKER_BRANCH"
  echo "✓ Bulker synced successfully"
else
  echo "Adding bulker repository as subtree..."
  git subtree add --prefix="$BULKER_PREFIX" "$BULKER_REPO" "$BULKER_BRANCH"
  echo "✓ Bulker added successfully"
fi
