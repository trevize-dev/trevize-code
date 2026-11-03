---
name: trevize-upstream-sync
description: Merge a new upstream T3 Code release tag into the Trevize fork. Covers picking the tag, a dry-run conflict check, resolving the conflicts we keep hitting, verification, and the PR. Use when upstream tags a release or when asked to sync, update, or catch up with upstream. Add what you learn to the log at the end.
---

# Trevize upstream sync

Trevize is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). We sync on
**stable upstream release tags** (`vX.Y.Z`), not upstream `main` and not `-preview`/`-nightly` tags.
Tags are points upstream has shipped and tested, and they make our releases easy to explain
("Trevize = T3 Code vX.Y.Z + our changes"). If we need an upstream fix between tags,
cherry-pick that commit instead of moving to `main`.

Sync every stable tag. Skipping releases makes the merge grow faster than linearly,
mostly in the connection layer and `ChatView`.

## 1. Pick the tag and dry-run

The `upstream` remote points at `https://github.com/pingdotgg/t3code.git`. Fetching takes
minutes (thousands of tags), so run it in the background.

```bash
git fetch upstream --tags
git tag -l 'v*' --sort=-v:refname | grep -vE 'preview|nightly' | head -3   # latest stable tags
MB=$(git merge-base main <tag>)
git rev-list --count $MB..<tag>                                  # upstream commits to take in
git merge-tree --write-tree --name-only main <tag> | sed -n '2,/^$/p'   # conflicting files, no checkout touched
```

Report the commit count and the conflict list to the maintainer before starting if it looks
unusually large.

## 2. Merge in a worktree

Never merge in the main checkout; it often has uncommitted work.

```bash
git worktree add -b trevize/sync-<tag> ../trevize-code-sync-<tag> main
cd ../trevize-code-sync-<tag>
git merge --no-ff --no-commit <tag>
vp i        # needed for typecheck and route generation; never hand-resolve pnpm-lock.yaml
```

## 3. Resolve conflicts

Pattern by pattern, the conflicts we have seen:

- **Branding** (`apps/desktop/package.json`, `DesktopAppIdentity.test.ts`,
  `DesktopPreReadyPlatform.test.ts`, `apps/web/index.html`, `T3Wordmark.tsx`,
  `scripts/build-desktop-artifact*`). Take upstream's side, then swap "T3 Code" for "Trevize".
  Follow upstream's stage-label changes (Alpha → Beta in v0.1.0; the
  `DesktopAppStageLabel` contract enforces it). Keep `productName` as plain `"Trevize"` so
  install and userdata paths stay stable. Only rebrand places the fork already rebranded;
  `electron-launcher.mjs` and most of mobile still say T3 Code on purpose.
- **Auto-merged upstream branding.** New upstream code merges cleanly and still says
  "T3 Code" in places we brand (e.g. a new protocol assertion in
  `build-desktop-artifact.test.ts`). Failing tests point at these; also run
  `git diff main -- scripts/build-desktop-artifact* | grep '"T3 Code'`.
- **`apps/web/src/routeTree.gen.ts`.** Take theirs, then regenerate so our routes
  (`_chat.spaces.$spaceId`) come back:

  ```bash
  git checkout --theirs apps/web/src/routeTree.gen.ts
  cd apps/web
  G=$(ls -d ../../node_modules/.pnpm/@tanstack+router-generator@*/node_modules/@tanstack/router-generator | tail -1)
  node --input-type=module -e "import {Generator,getConfig} from '$G/dist/esm/index.js'; await new Generator({config:getConfig({autoCodeSplitting:true},process.cwd()),root:process.cwd()}).run()"
  grep -c spaces src/routeTree.gen.ts   # must be > 0
  ```

- **Both sides added code at the same spot** (tests in `rightPanelStore.test.ts`,
  `connection/onboarding.test.ts`, `connection/registry.test.ts`; JSX in `routes/_chat.tsx`).
  Keep both. Watch the closing lines (`});`, `}).pipe(...)`) that git leaves outside the hunk;
  ours usually needs them repeated before theirs starts.
- **Our feature in upstream-owned code** (`Sidebar.tsx` hides space environments,
  `ChatView.tsx` `titleRow` and the Trevize wake hook, `connection/routes.ts` route-learning
  opt-out). Keep our behavior and adopt upstream's new names and props around it
  (e.g. `ChatHeader` callbacks became `...Stable`). Drop variables upstream stopped using.
- **Upstream moved or deleted the file our change lived in.** Big hunks where one side is
  a whole block and the other is empty usually mean upstream split, moved, or deleted the
  code. Take theirs, then re-apply the fork's delta (`git diff <previous tag> main -- <file>`)
  wherever the code went. In v0.1.6: `LegacySidebar.tsx` was deleted (only `Sidebar.tsx`
  remains); user rows moved to `chat/TimelineUserMessageRow.tsx` and
  `chat/UserMessageContextChips.tsx`; right-panel content to
  `chat/RightPanelSurfaceContent.tsx`; `SavedBackendListRow` to
  `settings/SavedEnvironmentRows.tsx`. Tests upstream deleted (it prunes low-signal tests
  in bulk) stay deleted, even when we had rebranded them.
- **Mechanics.** With 30+ conflicts, a small script that resolves hunk N as
  ours/theirs/both/custom text beats hand edits. Keep it outside the worktree.

## 4. Fix breakage outside the conflicts

Clean merges still break. Seen so far:

- Upstream removes an import once its own usage is gone, but our code still uses it
  (`isLearned` in `connection/registry.ts`).
- Upstream changes or deletes helpers that `apps/web/src/trevize/*` calls
  (`applyProviderInstanceSettings` gained `projectId`; `sortProviderInstanceEntries` became
  `providerInstanceEntriesFor`; `deriveActivePlanState` is gone, so read
  `projection.plans` directly). Copy how upstream's own callers adapted. Typecheck finds these.
- Test doubles of upstream services drift (`EnvironmentRegistry` lost `registerPlatform`
  and gained `assertKnownAddress`), and so do test helpers (`eventuallyState` became
  `awaitState`).
- Upstream keeps adding lint rules (v0.1.6: React Compiler `no-manual-memo`,
  `no-unreasoned-state-sync`, `no-low-value-comments`, `prefer-effect-fn`) and CI lints the
  whole repo, so every fork file must meet them, not just the ones the merge touched. Run
  `vp lint` at the root and fix all errors in this PR. Kept effects get
  `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <what it syncs and why>`.
- Upstream tests with hard-coded dates rot (v0.1.6: usage fixtures fell out of the 92-day
  window). If a test fails in a file the fork never touched, look for an upstream fix after
  the tag (`git log <tag>..upstream/main -- <file>`) and cherry-pick it with `-x`.

## 5. Verify

Typecheck per package. CI fails on Effect plugin diagnostics (`error TS377…`) too, so treat
every `error TS` line as real:

```bash
for p in packages/contracts packages/client-runtime apps/web apps/desktop apps/server apps/mobile; do
  echo "### $p"; (cd $p && vp run typecheck 2>&1 | grep 'error TS')
done
```

Run every test file the fork touches, per package. After the merge, `git diff <tag> HEAD` is
exactly the fork's delta. Use bash: zsh doesn't word-split `$files`.

```bash
bash -c 'git diff --name-only <tag> HEAD | grep -E "\.test\.tsx?$" | while read f; do [ -f "$f" ] && echo $f; done > /tmp/tests.txt
for pkg in apps/desktop apps/web packages/client-runtime; do
  files=$(grep "^$pkg/" /tmp/tests.txt | sed "s#^$pkg/##"); echo "### $pkg"
  (cd $pkg && vp test run $files 2>&1 | grep -E "FAIL|Test Files|Tests ")
done
vp test run scripts/build-desktop-artifact.test.ts 2>&1 | grep -E "FAIL|Tests "'
```

Known macOS-only failures, not merge-related:

- `DesktopUserData.test.ts` "preserves Windows credential keys from Trevize": "Trevize" and
  "trevize" are the same directory on a case-insensitive disk.
- `build-desktop-artifact.test.ts` "skips the primary native probe for cross-architecture
  Windows payloads": fails on unmodified upstream too.

To check whether a failure is upstream's, copy the pristine files from the tag next to ours
under a temporary name, run them, and delete them.

Run `vp lint` at the root; it must report 0 errors (warnings are upstream's). The commit
hook runs `vp fmt`. After pushing, check `gh pr checks`; the PR isn't done until CI is green.

## 6. Commit and PR

Commit as `chore: merge upstream T3 Code <tag>`. Push and open a PR into `main` only when the
maintainer asks. Title `chore: sync with upstream T3 Code <tag>`; the body lists how each
group of conflicts was resolved, the fixes outside the conflicts, and verification results,
including known failures.

Before finishing, add anything new you learned to the log below and update the sections above
if a pattern changed. Prune entries that no longer apply.

## Log

- **v0.1.0 (2026-10-17).** First tag sync; we had diverged since 2026-10-08 (574 upstream
  commits). 14 conflicts, plus two breakages outside the conflicts (`isLearned` import,
  NewSpaceDialog signatures). Upstream renamed Alpha → Beta. PR #12.
- **v0.1.6 (2026-11-03).** 3,071 upstream commits, 33 conflicts. Most came from upstream
  deleting tests and moving code (see "moved or deleted" above). HTTPS-paired tokens no longer
  go over plain HTTP, so route tests need HTTPS sample addresses. New lint rules and Effect
  diagnostics turned CI red across ten untouched Trevize files; fixed in the same PR. A dated
  usage test needed upstream's clock-pinning fix cherry-picked.
