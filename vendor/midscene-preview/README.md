# Midscene official preview source

Source: https://github.com/web-infra-dev/midscene

Pinned revision: `81e582c3a84450663dc4c004103af507dfdd615c` (Midscene 1.12.4).

These files are copied from that revision:

- `playground-app/*` ← `packages/playground-app/src/*` (eight named preview dependencies).
- `visualizer/screenshot-viewer/*` ← `packages/visualizer/src/component/screenshot-viewer/*`.
- `LICENSE` ← repository root `LICENSE`.

`visualizer/index.ts` is a local narrow export entry. It exports the official
ScreenshotViewer and copies only the two standalone type declarations needed by
runtime-info from upstream `packages/visualizer/src/types.ts`. Vite and TypeScript
redirect `@midscene/visualizer` to this entry because that internal package is not
published independently. No vendor interaction implementation is rewritten.

The only change in copied source is the `contentRef` type in
`DeviceInteractionLayer.tsx`: `RefObject<HTMLElement>` becomes
`RefObject<HTMLElement | null>` to match React 19's nullable ref typing.
All other copied source files are byte-for-byte identical to upstream.

The separate host in `src/official-preview` creates the published PlaygroundSDK,
mounts the official PreviewRenderer under Ant Design providers, and implements
the workspace stop handshake. The host pauses new input, allows the official
batch timers to finish, and waits for SDK interaction completion before reporting
`workspace-preview:flushed`. It does not alter interaction payloads or capture
rules. The surrounding Workspace UI continues to use shadcn and Tailwind.

The upstream rslib build enables Node polyfills (excluding console). The separate
Vite preview build includes browser polyfills for the SDK's Buffer and process
references. Node-only filesystem and network modules remain externalized and are
not used by this remote-execution SDK path. These polyfills do not grant the iframe
Electron or operating-system access.

The original MIT copyright and license are included in `LICENSE`.
