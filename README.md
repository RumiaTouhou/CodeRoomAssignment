# CodeRoom

CodeRoom is a web chat application where guests can join the shared room `lobby` by entering a display name without creating an account. After joining, guests can exchange text and code messages through WebSocket without refreshing the page, and search messages still saved in SQLite when they need to review an earlier discussion.

## Features

| Feature | Behavior |
| --- | --- |
| Text and code | The browser displays text messages without interpreting HTML. Code messages keep indentation, tabs and line breaks, show a language label and let guests copy the original code. |
| Durable history | SQLite saves retained messages, reactions, message order and operation receipts used for retries, and the server reads the saved data after a restart. |
| Guest identity | The browser saves a restore credential that lets returning guests use the same identity after their session ends. Guests can also join with a new identity. |
| Administrator access | Guests can join without a password. A guest who enters the administrator password can use admin controls, and the server checks permission before accepting an admin action. |
| Public pin | Administrators can pin one message for everyone. The server saves a full copy of that message, which remains available after the server removes the original from room history or restarts. |
| Member activity | The room shows who is online and records when guests join, leave or return, keeping those records after page refreshes and server restarts. Quick reconnects and page refreshes do not add extra leave or return records, but using the leave button records a departure immediately. |
| Message time context | Recent messages show their time, messages from the previous six days show how long ago they were sent, and older messages show their full date and time. Member activity records use the same rule. |
| Smart scrolling | New messages scroll into view when a guest is reading the latest conversation, but do not move the list when the guest reads older messages or opens a search result or quote. The **Jump to latest** button shows how many new messages arrived and takes the guest to the latest messages, while **Back to reading position** returns the guest to the previous reading position after opening a search result or quote. |
| Long-message folding | Guests can expand or collapse messages longer than 12 lines or 1,200 Unicode code points. Search and copying still use the complete content, and opening a folded message from search or a quote expands it. |
| Reading sizes | Standard, Large and Larger use text sizes of 16, 18 and 20 pixels, with code sizes of 14, 16 and 18 pixels. The browser saves the chosen size. |
| Saved bookmarks | A bookmark saves the author, time and full content of a message. Guests can open the original message while it remains in room history, or read and copy the saved content after the original message is removed. |
| Draft protection | The browser saves text and code drafts in different buffers for each tab and session. Send shortcuts do not submit a message while the guest is using an input method editor (IME) to enter text. Guests can choose the send shortcut for text, while code uses Ctrl/Cmd+Enter. Tab inserts a tab in either editor; Escape followed by Tab moves focus forward and Shift+Tab moves focus backward. |
| Typing indicators | Guests can turn typing indicators off in preferences. When typing indicators are enabled, the client sends typing status without draft text and the server removes expired typing indicators. |
| Reactions | Guests can add or remove any of five emoji reactions on messages. The server records which guests have selected each reaction. |
| Quoted replies | A reply saves the quoted author's name and a preview of up to 160 Unicode code points from the quoted text. If the server removes the original message from room history, guests can still read the preview, and the interface will show that the original is no longer available. |
| Message grouping | Consecutive text messages from the same guest appear in a compact group, but each remains an individual message. |
| History search | Guests can search retained text and code messages using literal, case-insensitive matching. Search highlights matches and lets guests open a matching message in the conversation. |
| Incoming sound | Guests can enable a sound for new messages. The client checks window focus and visibility and waits between sounds; the browser restores the saved preference after a refresh without playing a startup sound. If the browser blocks playback, the client will try again when another message arrives. Guests can use the **Preview** button to test playback and see playback errors in preferences. |
| Member sound | When member sounds are enabled, `EnterRoom.wav` plays when guests join or return, and `LeaveRoom.wav` plays when they leave. Member sounds have their own preference under the main sound control and do not play when the browser restores preferences or history. |

## Run locally

CodeRoom requires Node.js **22.13 or later** and npm, with Node.js 24 recommended. On macOS or Linux, open a terminal in the repository folder containing `package.json` and run these commands to check the installed tools, install dependencies and start the development servers.

```sh
node --version
npm --version
test -f package.json
npm ci
npm run dev
```

On Windows, run these commands in PowerShell.

```powershell
node --version
npm.cmd --version
Test-Path .\package.json
npm.cmd ci
npm.cmd run dev
```

After `npm run dev` starts Vite and the Node server, open **http://localhost:5173** in a browser. Vite serves the frontend at that address and forwards `/api` and `/ws` requests to the Node server on port 8080.

You can also build the application and run the frontend, HTTP API and WebSocket endpoint through Node on port 8080.

```sh
npm run build
npm start
```

After `npm run build` creates the browser files in `client/dist` and the server files in `dist/server` and `dist/shared`, `npm start` runs the application at **http://localhost:8080**.

For a production build in Windows PowerShell, use these commands.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `114514` | Password required for administrator access. The server checks the password when a guest requests administrator access but does not include it in messages or the public member list. Set a private password before making the application available to other people. |
| `DATA_FILE` | `data/coderoom.sqlite` | SQLite file for room data and guest restore records. `:memory:` uses temporary storage. |
| `VITE_API_ORIGIN` | Current page origin | HTTP origin used by the browser to reach the backend. The browser opens a WebSocket connection at `/ws` on the backend origin. Set during the frontend build. |
| `PORT` | `8080` | Port used by the Node server. The development proxy expects port 8080. |
| `HOST` | `0.0.0.0` | Address where the Node server listens. |
| `ALLOWED_ORIGINS` | Local Vite origins | Comma-separated list of allowed browser origins, including scheme and port. Requests from the server's own origin are also accepted. |
| `STATIC_DIR` | `client/dist` under the working directory | Folder containing frontend files served by Node. |

In PowerShell, you can set the administrator password and SQLite file location before starting the server.

```powershell
$env:ADMIN_PASSWORD = "a-private-room-password"
$env:DATA_FILE = ".\data\coderoom.sqlite"
npm.cmd start
```

The backend accepts browser requests from pages on the same origin as the backend, as well as from `http://localhost:5173` and `http://127.0.0.1:5173` when `ALLOWED_ORIGINS` is not set. For a frontend running on another origin, set `VITE_API_ORIGIN` to the backend's origin during the frontend build and add the frontend's origin to `ALLOWED_ORIGINS` on the server.

## State and retention

The server saves messages, reactions, message order, room identity, revisions, guest records and recent operation receipts in SQLite, and waits for each save to finish before confirming an accepted room change. After a server restart, CodeRoom will read the saved records from the database, so please keep the SQLite files on persistent storage if you want messages and guest identities to remain available.

CodeRoom keeps **at most 300 messages and 1 MiB of serialized history** in SQLite, removing the oldest messages whenever adding a new message would make the retained history exceed either limit. Guests can search only the messages still in room history, while a pinned message remains available through its own saved copy even after the original is removed.

### Guest sessions and membership

A guest can return to CodeRoom with the same identity after an earlier session expires, as guest sessions can last up to 12 hours while a restore credential saved in the browser can remain valid for up to 30 days. When a restore credential is available, the join screen will select **Use saved guest identity** by default, and clearing the checkbox lets the guest join with a new identity. Returning administrators need to enter the administrator password again, as the restore credential preserves guest identity but not administrator access.

When a guest clicks **Leave room** in the room header, the server will record the departure immediately, but after an unexpected disconnection it will wait **10 seconds** before recording a departure, allowing guests who reconnect during that time to avoid extra leave and return records. The server does not record connected guests as leaving during a normal shutdown. The server saves the latest 200 join, leave and return records in SQLite to keep those records available after a page refresh or server restart, even when older chat messages have been removed.

### Browser storage

The browser saves the current session credential in `sessionStorage` and stores drafts and unconfirmed messages there under the corresponding backend, guest and room IDs to allow guests to resume the same session after refreshing a tab. In cases where saving a draft fails, the browser will keep the text being edited in memory and show an error.

The browser uses `localStorage` to keep guest restore credentials, preferences and bookmarks available on later visits. Each guest can save **at most 100 bookmarks and 1 MiB** of message snapshots per backend and read or copy saved content even after the server removes the original messages from room history. The browser keeps each bookmark until the guest removes it individually or clears all bookmarks.

## Architecture

The browser and server use the room data types and WebSocket event formats in `shared/` when exchanging events. The server checks requests and saves accepted room changes before sending updates to connected clients, which use those updates to display the current conversation. The following folders contain the code for these operations, the interface and the tests.

- `shared/` defines the room data, WebSocket events, limits and runtime validation.
- `server/` handles HTTP and WebSocket requests, guest sessions, rate limits, room changes, SQLite and frontend file serving.
- `client/src/app/` manages application state, sessions, search, navigation and the React application.
- `client/src/services/` handles HTTP and WebSocket communication, browser storage and audio.
- `client/src/ui/` contains chat interface components and styles.
- `client/src/preview/` contains sample UI states for checking the interface without joining the live room.
- `tests/` contains tests for room behavior, WebSocket communication, saved data, permissions, client state and the interface.

### Sessions and real-time messages

When a guest enters a display name, `client/src/services/http.ts` sends `POST /api/sessions`, and `server/app.ts` uses `server/sessions.ts` to create or restore the guest identity and return a session credential. After opening `/ws`, the browser sends the credential in `session.authenticate`, and the server returns `session.ready` with a snapshot of retained messages and online members.

When an authenticated guest submits a message, the browser will send `message.send` with an operation ID, and `server/app.ts` will validate the event before passing the request to `server/room.ts`. The server gets the author from the guest session, assigns a message ID and sequence number, saves the accepted message in SQLite, then broadcasts `room.delta` to connected clients and sends `message.accepted` to the sender.

When a guest searches an earlier discussion, the browser uses HTTP rather than WebSocket to send `GET /api/rooms/lobby/search` with the session credential in the `Authorization` header, and the server returns matching text and code messages from retained room history.

### Synchronization and uncertain messages

The server assigns a revision number to each accepted room change, and the browser checks the revision on `room.delta` to detect missing updates. When the browser detects a missing update, it will request `room.sync` to receive a current `room.snapshot`.

The connection may close after the server saves a message but before the browser receives `message.accepted`, leaving the browser unsure whether the message was saved. The browser will show the connection status and keep the message unconfirmed, then check the latest room snapshot after reconnecting without automatically sending another copy. When the result is still unknown, the guest can retry with the original operation ID, and the server will return the earlier result without creating another message as long as the saved operation receipt is still available.

### Validation and code display

The server checks HTTP requests and WebSocket events using `shared/validation.ts` before processing them, while the browser checks incoming server events before updating the displayed room. After checking a message event, the browser displays the message content as text without interpreting HTML or running code shared by guests.

## Extending CodeRoom

### Changing WebSocket behavior

When adding a WebSocket event, define the event type in `shared/ws.ts`, add data validation in `shared/validation.ts` and handle the event in `server/app.ts`. An event that changes the shared room would also need an operation in `server/room.ts`, where the server can check the request and save the accepted change. The browser receives WebSocket events through `client/src/services/realtime.ts`, so the new event would need handling in `client/src/app/controller.ts` and updates to any affected components in `client/src/ui/`.

### Changing stored data

The server stores room records and guest identities through `server/room.ts`, `server/sessions.ts` and `server/database.ts` in SQLite's `application_state` table. When changing the format of saved records, update the code that reads the previous format and test with both an existing database and a new database, since people running an earlier version may already have saved records.

Developers changing browser storage in `client/src/services/storage.ts` or the stored data types in `shared/persistence.ts` could also test with data saved by earlier versions, since earlier records may still be in the browser after a CodeRoom update.

### Changing the interface

The interface components are in `client/src/ui/`, and developers changing layouts or visual controls could use the [UI state preview](#ui-state-preview) to inspect the result without joining the live room.

### Adding rooms

Adding rooms beyond `lobby` would require changes to shared room types, server room data and routes, and browser room selection so each room could have its own messages and members.

## Checks

GitHub Actions will run the checks in `.github/workflows/checks.yml` after pushes and pull requests, and you can run the type, test, build and release checks locally from the repository root using these commands.

```sh
npm run typecheck
npm test
npm run build
npm run test:release
```

The Node tests cover room behavior, WebSocket events, stored data and client state. Developers changing real-time events or stored records could use existing tests in `tests/server-*.test.ts`, `tests/process-persistence.test.ts` and the related application tests when adding new tests.

When you run `npm run test:browser`, Playwright will build CodeRoom, start a production Node server on localhost and use Chromium to test sound and clipboard behavior. The clipboard tests give Chromium permission to read and write clipboard content, and localhost meets the secure-context requirement for clipboard access. Please install Chromium and run the tests with these commands.

```sh
npx playwright install chromium
npm run test:browser
```

On Linux, `npx playwright install --with-deps chromium` can also install the system packages required by Chromium. In Windows PowerShell, use `npx.cmd playwright install chromium` and `npm.cmd run test:browser`.

## UI state preview

The UI state preview uses the chat interface components with sample data to let developers check the English interface on desktop, split-screen and mobile layouts without joining the live room. The following commands build and serve the preview from `client/dist-preview` without adding preview files to the production build.

```sh
npm run build:preview
npm run preview
```

Open **http://localhost:4173/preview.html** to inspect the interface states.

## Deployment

Run CodeRoom as a single Node server, since each process keeps its own live room state and WebSocket connections in memory.

### Docker

The commands below will build a Docker image and start a container with Node running as a non-root user on port 8080, a health check at `/api/health` and a Docker volume for SQLite.

```sh
docker build -t coderoom .
docker run --rm --name coderoom -p 8080:8080 -v coderoom-data:/app/data -e ADMIN_PASSWORD=a-private-room-password coderoom
```

The `-v` option keeps SQLite files in the `coderoom-data` volume when the container is replaced, while `-e` sets `ADMIN_PASSWORD` or other runtime variables such as `PORT` and `ALLOWED_ORIGINS`. For public access, configure HTTPS and WebSocket upgrades on the host or reverse proxy that sends browser requests to the Docker container.

### Frontend and backend on different hosts

For a frontend hosted on Netlify, `netlify.toml` builds the browser files with `npm ci && npm run build:client` and publishes `client/dist`. Configure the Node server and frontend with these steps.

1. Run the Node server on an HTTPS host with WebSocket upgrade support and persistent storage for the SQLite files.
2. Before building the frontend, set `VITE_API_ORIGIN` in Netlify to the backend's HTTPS origin, such as `https://chat-api.example.com`.
3. Set the backend's `ALLOWED_ORIGINS` to the deployed frontend origin, such as `https://chat.example.com`.

## Contributing

The `.gitignore` excludes dependencies, build files, `.env` files and the local `data/` directory, but check the remaining files in your pull request for passwords, credentials or SQLite data before submitting. Run the relevant commands in [Checks](#checks) and describe the change and tests in the pull request, including steps to reproduce a bug or an explanation of how a new feature works in the browser and server.
