# ServerHub

ServerHub keeps SSH and MySQL connections close to your VS Code workspace.

## Features

- Dedicated ServerHub view in the Activity Bar.
- Add SSH or MySQL servers from the view title menu.
- Open interactive SSH sessions using password or private key certificate authentication.
- Route SSH connections through an optional proxy command, such as `cloudflared access tcp --hostname host.example.com`.
- Open MySQL connections in an editor, switch databases, and browse table metadata in list or grid view.
- Double-click a MySQL table to preview its first 100 rows in a separate editor.
- Edit or delete saved servers from the tree context menu.
- Import and export server connections as JSON, including credentials.
- Store passwords, private keys, and key passphrases in VS Code Secret Storage instead of plain-text extension state.

## Usage

1. Open ServerHub from the Activity Bar.
2. Select the add button in the Server List title and choose **SSH** or **MySQL**.
3. Enter the connection details and save the server.
4. Select the connect button beside the server.
5. For MySQL connections, select a database and choose list or grid view from the action bar.
6. Double-click a table to preview up to 100 rows in a separate editor.
7. Right-click a server to edit or delete it.

Use the import and export buttons in the Server List title to move connections between devices. Export files contain passwords, private keys, and key passphrases in plain text, so keep them secure and delete them when they are no longer needed.

## Development

The extension host code lives in `src` and is compiled with TypeScript. React webviews live in `webviews` and are bundled by Vite into `resources/webview`.

- `npm run compile` builds the React webviews and extension host code.
- `npm run watch` watches both build pipelines.
- `npm run build:webview` builds only the Vite webviews.

The server form is the first React webview. Other editors can migrate incrementally by adding another Vite entry in `vite.config.mjs` and loading its generated assets through a VS Code webview URI.