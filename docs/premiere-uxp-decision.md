# Architecture decision: Premiere Pro uses UXP

Status: accepted for the remaining implementation plan.

## Decision

The After Effects panel remains a CEP extension. The Premiere Pro version is a
separate UXP plugin with a minimum supported Premiere version of 25.6. The two
hosts share an on-disk `.parddefender` protocol, not a UI runtime or Adobe DOM.

Do not add `PPRO` to the existing CEP manifest and do not use the unsupported QE
DOM. Premiere code uses the official asynchronous UXP API:

- `require("premierepro")`;
- `Project.getActiveProject()`, `Project.guid`, `Project.path`;
- `ClipProjectItem.getMediaFilePath()`, `getProxyPath()`, `hasProxy()`;
- `ClipProjectItem.canChangeMediaPath()` and `changeMediaFilePath()`;
- UXP `fs` and `path` modules with declared filesystem permission.

Official references:

- https://developer.adobe.com/premiere-pro/uxp/
- https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project
- https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/clipprojectitem
- https://developer.adobe.com/premiere-pro/uxp/resources/recipes/filesystem-operations/

## Compatibility boundary

The common contract is data, not implementation:

- workspace/project identity schemas;
- append-only event and relink-intent schemas;
- duplicate group/content identity schemas;
- safety invariants and state-machine semantics.

CEP Node and Premiere UXP have different module, filesystem and asynchronous
models. Host implementations may differ internally as long as the persisted
schemas and transaction semantics remain compatible.

## Meaning of duplicate merge

The supported operation is exact-file consolidation: all eligible project
items are relinked to one verified canonical file. Project items remain in the
Adobe project. Semantic merging/removal of project items is deliberately not
automatic because interpretation, markers, subclips, multicam/merged clips and
host-specific metadata can differ even when source bytes are identical.

