# Self-hosted game catalog

NovaPS5's Games tab reads game **metadata** from the public PlayStation Store. It never downloads
game content from Sony or third-party game sources. To make a catalog entry installable, point
NovaPS5 at a catalog **you host**: a JSON file listing dumps you already have and where each archive
lives.

You can use either:

- a URL — `https://my-server/games/catalog.json`
- a local path — `C:\Games\catalog.json` or `file:///C:/Games/catalog.json`

Set it in **Games → Catalog settings → Self-hosted catalog**. Entries from the catalog appear first
in the games list, carry a **Download** badge, and can be downloaded + converted in one click.

## Format

```json
{
  "name": "My backups",
  "games": [
    {
      "id": "astro-bot",
      "name": "ASTRO BOT",
      "titleId": "PPSA21564",
      "publisher": "Sony Interactive Entertainment",
      "genres": ["Action", "Platformer"],
      "releaseDate": "2024-09-06",
      "coverUrl": "covers/astro-bot.jpg",
      "heroUrl": "covers/astro-bot-hero.jpg",
      "sizeBytes": 37886558208,
      "downloadUrl": "astro-bot.zip",
      "sha256": "9f2c…",
      "storeUrl": "https://store.playstation.com/en-gb/product/EP9000-PPSA21564_00-ASTROBOT00000000"
    }
  ]
}
```

A bare array (`[{ … }, { … }]`) is also accepted.

## Fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Shown on the card and used as the install name. |
| `id` | no | Stable key. Defaults to a slug of `name` plus the index. |
| `downloadUrl` | no | Archive URL (`.zip`, `.rar`, `.7z`) or a local path. Relative values resolve against the catalog location. Without it, the entry is metadata/wishlist only. |
| `sha256` | no | Hex SHA-256 of the archive. When present, the download is verified before installing. |
| `sizeBytes` | no | Download size, shown before installing. |
| `coverUrl` | no | Portrait art. `https://…`, a relative path, or a local file next to the catalog (embedded as a data URL, max 4 MB). |
| `heroUrl` | no | Wide art for the detail dialog. |
| `titleId` | no | PS5 title id (e.g. `PPSA21564`). Used to mark a game as installed. |
| `publisher`, `genres`, `releaseDate`, `storeUrl` | no | Display metadata. |

## How downloads run

1. The archive streams to `<libraryRoot>/downloads/<game>-<timestamp>/`.
2. If `sha256` is set, the checksum is verified.
3. The archive is handed to the normal install pipeline: extract → unwrap → relink → launch test.
4. On success the staged archive is deleted and the game appears in your library.

Progress is shown on the game's page and card. You can cancel during the download; conversion itself
isn't interruptible.

## Relative URLs

For a remote catalog, `downloadUrl` and cover paths resolve against the catalog URL:

```
https://my-server/games/catalog.json
  → astro-bot.zip becomes https://my-server/games/astro-bot.zip
```

For a local catalog, they resolve against the catalog file's folder. A local `downloadUrl` can point
at an archive **or a dump folder**; no network copy is made.

## Security

The catalog is code-free JSON. Keep it on a server you trust: whatever URL an entry names is what
NovaPS5 will fetch. Use `sha256` when the archive crosses a network you don't fully control.
