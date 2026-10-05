# 2026-10-05 — "↗" a KairoWeb, preguntas de Claude y la tarjeta de permiso

Sesión abierta desde el repo, en paralelo con otra sesión de Claude Code que trabajaba el chat
(rama `chat-deny`, en la carpeta principal). Por eso todo lo de esta sesión se hizo en worktrees
propios: `.claude/worktrees/title-state` (rama `fix-title-editor-state`) y
`.claude/worktrees/permission-card` (rama `permission-card`, que incluye a la anterior).

## Qué se hizo

### 1. "↗" no llevaba a la ventana de KairoWeb

Manuel reportó que la redirección de una sesión "no lleva a ningún lado" (captura con
`struxto-especificador`, `panita` y `KairoWeb` en la isla).

1. **El log señaló a KairoWeb, no a panita.** En `coucou.log`, cada click en KairoWeb dejaba
   `terminal "…" focused in "KairoWeb"` seguido de
   `terminal shown, window not raised — no window titled for "KairoWeb" (a custom window.title?)`:
   la extensión mostraba la pestaña, pero la ventana no venía al frente. panita y struxto
   enfocaban bien (`set directly`), y KairoWeb sí había funcionado el 2026-10-04.
2. **Los títulos reales de las ventanas de `Code.exe`** (EnumWindows, solo lectura):
   - `ronda1b-hoja.jpg - KairoWeb - Visual Studio Code - Untracked`
   - `Welcome - panita - Visual Studio Code`
   - `prompt_arena.md - struxto-especificador [WSL: Ubuntu-24.04] - Visual Studio Code`

   `workspace_part` (`windows/src-tauri/src/vscode.rs`) exigía que el título terminara en
   `Visual Studio Code` o en una nota `[…]`; el ` - Untracked` final hacía que la ventana no
   matcheara nada.
3. **Arreglo** (rama `fix-title-editor-state`): `workspace_part` acepta ` - <estado>` después
   del nombre de la app, y sigue rechazando los títulos de VS Code Insiders. Tests nuevos con
   los títulos reales de esta máquina; se los vio fallar sin el arreglo (`window_named` →
   `None`, lo mismo que en la app) y pasar con él.

### 2. Preguntas, tarjeta de permiso y cerrar la isla (D-018)

Manuel, con otra captura (una tarjeta "panita needs permission · AskUserQuestion · Deny /
Allow"): no sabía qué le preguntaba Claude; quería un botón para ir a la sesión en esa tarjeta y
en la de permiso; que la explicación del comando ocupe hasta tres renglones en vez de cortarse
en "…"; y poder cerrar la isla siempre con un click arriba, aunque haya una pregunta abierta.

1. Se leyó el binario de Claude Code (ver "Qué se aprendió") antes de decidir, porque D-015
   prohibía plegar sobre un permiso con un supuesto que resultó falso.
2. Rama `permission-card`: `AskUserQuestion` se devuelve al instante y abre una **tarjeta de
   pregunta** (la pregunta, sus opciones, Open terminal / OK) que se cierra sola al contestarse;
   la tarjeta de permiso tiene **↗**; la explicación ocupa **hasta tres renglones** y la isla crece
   para mostrarlos; **un click** en la franja vacía del header (o `Esc`) pliega la isla siempre, y
   si había un permiso lo devuelve a la terminal.
3. Tests: 13 unitarios nuevos (`hooks.test.ts`, `layout.test.ts`), vistos fallar con `src/` de
   `main` y pasar con el cambio; el e2e del plegado reescrito y tres casos nuevos (pregunta,
   explicación de dos renglones, de tres con "…"), más el ↗ en la tarjeta de permiso.
   Resultado en PowerShell: Rust 102 + 24, vitest 463, e2e 70 en verde y 1 salteado (el lento,
   `COUCOU_E2E_SLOW`). Se miraron las capturas `1c2-question`, `36-explain-two-lines`,
   `37-explain-long` y `1a-approval-session`.

### 3. Integración e instalación

Manuel mergeó `permission-card` (`8f7be3b`). Después se integró `chat-deny` (la otra sesión,
D-017) en `integration3`: un cherry-pick sobre `main` con un solo conflicto, el final de
`memoria/decisiones.md` (quedó D-017 antes de D-018). Se revisó a mano su diff de producción:
solo escribe `chat\settings.json` en la carpeta de la app, nunca el `~/.claude/settings.json`.
Suites en PowerShell: Rust 103 + 24, vitest 463, e2e 70 y 1 salteado. Manuel mergeó
(`f5e00a8`) e hizo Quit; se reinstaló con `/S` y la app arrancó desde `%LOCALAPPDATA%\Coucou`.

### 4. Pegar imágenes en el chat (D-019)

Manuel: "no puedo pegar imágenes al chat de panita". La caja era un `<input>` sin manejo de
pegado, y el único camino para una imagen era arrastrarla a la isla, que además solo viajaba con
el primer mensaje. Rama `chat-paste`: `Ctrl+V` de una imagen la guarda en el inbox
(`paste_image`, bytes como cuerpo crudo) y va con el próximo mensaje, sea o no el primero.
Tests: Rust (`files.rs`, nombre, tipos y tamaño), `bridge.test.ts`, y en el e2e un `paste` real
del DOM con un PNG (sin abrir la vista de chat, que tomaría el teclado), verificado en el inbox
de la instancia lateral y en el mensaje que recibe el `claude` falso.

En la primera corrida falló el e2e de la tarjeta de pregunta (y en cascada el siguiente): medía
los renglones antes de que la isla terminara de crecer, y con la isla baja el flex achica las
filas. Había pasado antes por timing. Ahora espera el tamaño final, y contesta la pregunta en un
`finally` para no dejar la tarjeta arriba si algo falla.

### 5. Barra de uso de 5 horas (D-020)

Manuel pidió ver el uso de 5 horas en la franja del header, y también con la isla compacta. Para
no tocar credenciales se buscó en el binario de Claude Code de dónde sacarlo: lo da la status
line. Se presentaron tres opciones y Manuel eligió la status line. Rama `usage-bar`: el
instalador escribe `statusLine` = el relay con `StatusLine` (sin imprimir nada); `pipe.rs` se
queda con las dos ventanas y emite `usage`; dos medidores (header y compacta). De paso, la franja
del header llega hasta el borde de arriba. Antes no había `statusLine` ni en Windows ni en WSL
(se miró, solo lectura).

El e2e encontró un bug real en la primera corrida: sin datos, el medidor quedaba visible (una
barra vacía), porque el primer `sync` salía antes de ocultarlo. En esa corrida también falló una
vez "a bare git push…", sin relación aparente (O8). Segunda corrida: 73 en verde y 1 salteado;
Rust y vitest 472 en verde. Capturas mirando la compacta (`04c`), el header (`04d`) y el ámbar
(`04e`).

## Qué se aprendió

- `[CONFIRMADO]` (leyendo `workbench.desktop.main.js` de VS Code 1.140): VS Code agrega
  `${separator}${activeEditorState}` al título — el default o uno custom — cuando está en
  **modo lector de pantalla** (`isScreenReaderOptimized()`) y
  `accessibility.windowTitleOptimized` está en `true` (default). `activeEditorState` es el
  tooltip de la decoración del archivo activo: estado de git (`Untracked`, `Modified`),
  problemas. Por eso el bug **va y viene según qué archivo esté activo**: con "Welcome" o un
  archivo sin cambios no hay sufijo y "↗" anda.
- `[CONFIRMADO]` El VS Code de Manuel está en modo lector de pantalla por **detección
  automática**: `editor.accessibilitySupport` no está seteado (ni en user settings ni en el
  `.vscode/` de KairoWeb), y el sufijo solo aparece con ese modo activo. `SPI_GETSCREENREADER`
  de Windows da `false`. `[SUPUESTO]` Lo dispara algún cliente de UI Automation que Electron
  detecta como tecnología asistiva; no se buscó cuál.
- `[SUPUESTO]` Los `no window titled for "tesis-vhp"` del 2026-10-02 son la misma causa.
- `[CONFIRMADO]` (leyendo `~/.local/bin/claude.exe`, Claude Code 2.1.289): ante un permiso,
  Claude Code corre el hook `PermissionRequest` **y a la vez** muestra su diálogo en la terminal
  (`Promise.race`); y un "allow" del hook sin `updatedInput` para una herramienta que pide
  interacción se ignora. Detalle y grado de certeza en D-018. Los strings del binario se pueden
  leer con `grep -a -o`; búsquedas con ventanas grandes tardan más de dos minutos.
- `[CONFIRMADO]` en el log: el `AskUserQuestion` de las 11:57 (id `30600-14`) estuvo 108 s en la
  isla y se contestó en la terminal.
- **No pasar `git diff` por PowerShell a un archivo.** `Out-File` le agregó BOM y CRLF al patch y
  `git apply` restauró solo una parte de `src/` (se recuperó normalizándolo con `sed`). Para
  apartar cambios, un commit WIP.
- El nombre de instancia del e2e (`COUCOU_E2E_INSTANCE`) solo acepta `[a-z0-9]{1,32}`: sin guiones.

## Qué se decidió

- D-018 (supera a D-015 en lo del plegado). Numerada D-018 porque `chat-deny` ya tiene una D-017
  sin commitear.

## Qué queda pendiente

- Probar a mano en la app instalada: "↗" en KairoWeb con un archivo untracked o modificado
  activo; una pregunta real de Claude; el click en el header sobre un permiso (que la terminal
  siga preguntando); un doble click que no reabra la isla; un `Ctrl+V` real de una captura y que
  el Claude Code real la lea; la barra de uso con datos reales.
- Para la barra de uso, Manuel tiene que aplicar **Update…** en Settings → Claude Code, en la
  fila de Windows y en la de WSL (agrega la `statusLine`, viendo el diff).
- La rama `chat-deny` (de la otra sesión) quedó vieja: su commit ya está en `main` como
  `f5e00a8`. No se vuelve a mergear; esa sesión tiene que pasarse a `main`.
- Preguntas nuevas: I5 (contestar la pregunta desde la isla) y O7 (sacar la tarjeta de permiso
  cuando se contesta en la terminal).
- Fuera de panita: si Manuel no usa lector de pantalla,
  `"editor.accessibilitySupport": "off"` en sus settings de VS Code saca a VS Code de ese modo
  (que también cambia otros comportamientos del editor).
