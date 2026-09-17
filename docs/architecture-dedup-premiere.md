# PardDefender: duplicates, Premiere Pro and shared workspaces

Status: architecture proposal. This document defines boundaries and invariants;
it is not permission to migrate existing project metadata automatically.

## Product invariants

1. PardDefender never moves or deletes an original automatically. It copies,
   verifies, records provenance, and only then asks the host to relink.
2. A closed `.aep` or `.prproj` is never rewritten. Cross-host changes are
   queued and applied by the matching host adapter when that project is open.
3. Byte equality and project-item equality are different concepts. Exact
   duplicate files may share one canonical file without forcing After Effects
   or Premiere project items to be merged.
4. Destructive cleanup is always a separate, owner-confirmed transaction and
   sends owned files to the Recycle Bin. A successful relink is not permission
   to delete a source.
5. Existing `.parddefender/assets.tsv` ownership remains authoritative during
   migration. An equal file that is absent from the manifest is not treated as
   owned.

## Target layers

```text
CEP panel UI
  -> application service (audit, copy, dedup, shared-workspace coordinator)
     -> filesystem service (Node, common to both hosts)
     -> host adapter: After Effects ExtendScript
     -> host adapter: Premiere Pro ExtendScript
```

The current client modules become the common application/filesystem layer.
Host-specific calls must go through a small adapter contract instead of calling
`PardDefenderHost` directly from feature code.

Minimum adapter contract:

- `identifyProject()` -> host, stable project id, project path, save state;
- `auditMedia()` -> project items, media paths, usage and sequence/proxy data;
- `commitRelinks(plan)` -> stale-source checked relink results;
- `revealItem(locator)`;
- `removeUnusedProjectItems(plan)`;
- capability flags for features the host cannot implement safely.

One CEP extension may list `AEFT` and `PPRO` in `HostList`, but the host scripts,
locators and tests remain separate. Shared UI must render by capabilities, not
by scattered `if Premiere` branches.

## Shared workspace identity

Projects under the same resolved edit root share one workspace. Add a durable
file `.parddefender/workspace.json` with a generated `workspaceId`, schema
version and normalized root. Each open host registers a project under
`.parddefender/projects/<projectId>.json`.

Project identity must not be only a path: Save As changes paths. Generate an id
once, store the last known path and host, and require an explicit reconciliation
UI if two records claim the same path.

Concurrent AE and Premiere panels must not rewrite one monolithic JSON file.
Use append-only JSONL journals plus an atomic lock-directory protocol and
periodic compacted snapshots. Every event has `eventId`, `workspaceId`,
`projectId`, timestamp and schema version. Recovery must tolerate a truncated
last line.

## Cross-host relink synchronization

When an owned file gets a new canonical path, the coordinator writes one
idempotent relink intent per affected project. If the project is open, its
adapter may apply the intent immediately. Otherwise it remains pending until
the project opens.

Each intent contains the old path, new path, content identity, expected project
item locator and originating transaction. The adapter rechecks that the item
still points to the expected old path before relinking. A mismatch is reported
and never overwritten.

This is synchronization of references, not synchronization of host project
structure. AE folders/compositions and Premiere bins/sequences stay owned by
their respective adapters.

## Exact duplicate detection

Phase 1 supports exact byte duplicates only.

1. Group candidates by size.
2. Hash only groups with more than one candidate, using streaming SHA-256.
3. Cache `{path, size, mtime, hash}`; invalidate on size or mtime change.
4. Treat image sequences as ordered sets of frame identities plus the filename
   pattern, never as one representative frame.
5. Keep proxies distinct from originals even when bytes happen to match.

The existing 1 GiB interactive-copy hash limit must not silently weaken a full
duplicate scan. Large-file hashing runs throttled and cancellable, with progress.

## Two separate user actions

### Consolidate files

Choose one canonical managed file and relink all eligible project items to that
path. Keep the project items themselves. This is the safe first release and
works across AE and Premiere adapters.

Canonical preference order: verified owned path, path inside the current shared
workspace, non-temporary route, then stable lexical path. The UI shows the
choice and all impacted projects before commit.

### Merge project items

Optional later feature. It replaces references to duplicate project items with
one item and removes redundant items. This requires host-specific semantic
equivalence checks (interpretation, alpha, frame rate, duration, proxies,
markers and other host metadata). It must not ship as part of file
consolidation.

## Transaction for consolidation

1. Re-audit all open affected projects.
2. Copy canonical data if needed and verify it.
3. Persist ownership/provenance.
4. Write relink intents for every affected project.
5. Apply intents in open hosts and record each result.
6. Show pending closed projects explicitly.
7. Offer cleanup only when every known reference has either succeeded or the
   owner excluded it. Cleanup remains a separate confirmation.

## Delivery order

1. Manual refresh for forgotten-layer scan (small independent UX fix).
2. Extract an AE adapter behind compatibility-preserving wrappers.
3. Add workspace/project identity and concurrent journal tests.
4. Add read-only duplicate report and hash cache.
5. Add AE file consolidation, without deleting or merging project items.
6. Add Premiere audit/relink adapter and shared relink queue.
7. Only then evaluate semantic project-item merge per host.

