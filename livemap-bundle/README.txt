Live map files shipped with Enshrouded Server Manager.

- iphlpapi.dll: the live map mod, built from https://github.com/oggii/enshrouded-livemap (MIT),
  with one change: player names are read from the string's length (the original read stopped early and
  showed "Player N" instead of the name). Source of the change: livemap-build, read_name in src/world.cpp.
  Its license and third-party notices are in LICENSE-livemap.txt and THIRD_PARTY_NOTICES-livemap.md.
- livemap/: the web page, map tiles and icons the mod serves.

The app copies both into a server folder when the server is added (or when you click Install live map
on its Overview). The app does not run them itself.
