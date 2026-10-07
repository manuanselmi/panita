# CLAUDE.md — panita

> Contexto maestro del repo. Si sos una instancia de Claude Code trabajando acá, leé este
> archivo **al arrancar la sesión**. Después: la última entrada de `memoria/bitacora/`,
> `memoria/preguntas-abiertas.md`, y según la tarea `windows/README.md` y `windows/TESTING.md`.

## Regla cero: la memoria vive en el repo

Todo lo que merezca recordarse va a un **archivo versionado**, no a la memoria local de la
herramienta ni al chat. Una sesión futura tiene que poder levantar el contexto completo
leyendo el repo. Si en una sesión surge un hallazgo, una decisión o un descarte y no quedó
escrito en un archivo, **no pasó**.

## Regla uno: hablar corto

Español rioplatense, directo, sin relleno ni recapitulaciones. Una recomendación, no una
encuesta. Esto es para el chat: en los archivos del repo se escribe el razonamiento completo,
porque los lee alguien que no estuvo en la conversación.

## El proyecto

`panita` es el fork **privado** de Manuel de [Coucou](https://github.com/Louis-CFM/coucou), de
Louis Raillé: un personaje (Mochi) que vive arriba de la pantalla y muestra las sesiones de
Claude Code en curso, deja aprobar o rechazar permisos con un click y te lleva a la terminal
de cada sesión. El original es una app nativa de macOS (`NotchBuddy/`, Swift) con un port a
Windows (`windows/`, Tauri 2: Rust + TypeScript). **En este fork se trabaja solo la versión
Windows**, para uso propio en la PC de Manuel: Windows 11 Home, Claude Code corriendo en
terminales integradas de VS Code, tanto en Windows como en WSL (`Ubuntu-24.04`), muchas veces
varias sesiones a la vez y varias en el mismo proyecto.

Lo que el fork agregó sobre upstream (detalle y porqués en `memoria/decisiones.md`):

- Banco de pruebas automático con una **instancia lateral** que nunca toca la instalación real.
- **Una tarjeta por sesión**: la sesión más activa a la izquierda, el resto como "panitas"
  (mini Mochis de colores) a la derecha; numeración cuando dos sesiones se llaman igual.
- **Hooks en WSL**, instalados por distro con el mismo flujo de consentimiento que Windows.
- **"↗ / Open"** lleva a la ventana de VS Code de esa sesión (aunque esté en otro escritorio
  virtual) **y a la pestaña exacta de su terminal**, vía una extensión companion de VS Code.
- La tarjeta de permiso **explica el comando en español** (diccionario ampliable) y marca lo
  peligroso.
- Etiquetas de pasos en español; integraciones (Stripe, GitHub, etc.) apagadas por defecto.

## Estado: en uso diario

`main` es lo que está instalado en la máquina de Manuel. Estado al 2026-10-07 (salvo la fila App, que va un paso adelante hasta el merge):

| Qué | Dónde | Estado |
|---|---|---|
| App | `%LOCALAPPDATA%\Coucou\` (instalador NSIS por usuario, sin admin) | Instalada desde `cmd-terminal-focus` `ed293c0`: `main` + consola de cmd en ↗ (D-021), sin barra de contexto (D-022) |
| Hooks Windows | `%USERPROFILE%\.claude\settings.json` | Instalados (relay en `%LOCALAPPDATA%\Coucou\bin`), con la `statusLine` de la barra de uso (D-020) |
| Hooks WSL | `~/.claude/settings.json` de `Ubuntu-24.04` | Instalados, con `--wsl-ppid` y la `statusLine` (D-020) |
| Extensión VS Code | `coucou.terminal-focus` 0.1.0 | Instalada (por CLI) |
| Chat de la isla | corre el `claude` oficial, restringido y de solo lectura (D-016), sin leer secretos ni datos de clientes (D-017) | Instalado |

## Estructura del repo

| Carpeta | Qué va | Versionado |
|---|---|---|
| `windows/` | La app Windows. `src-tauri/` (Rust), `src/` (isla en TS sin framework), `hook/` (relay `coucou-hook.exe`), `vscode-extension/` (companion), `tests/` (unit + e2e), `scripts/` | Sí |
| `windows/README.md`, `windows/TESTING.md` | **Documentación técnica de la app y del banco de pruebas.** Fuente de verdad del código. | Sí |
| `memoria/` | Decisiones, preguntas abiertas y bitácora de sesiones. | Sí |
| `NotchBuddy/`, `design/`, `docs/` | Del upstream: app macOS, diseño y sitio de GitHub Pages. Los sonidos de `NotchBuddy/Resources/sounds/` los usa también Windows. No se tocan. | Sí |
| `.claude/worktrees/` | Worktrees de subagentes. | No (`.claude/` está ignorado) |

No hay un `docs/` propio del fork: `docs/` es el sitio del upstream (D-001).

## Cómo se trabaja

### Compilar, probar, instalar

Todo desde `windows/`. Rust vive en `%USERPROFILE%\.cargo\bin` y puede no estar en el PATH de
una shell nueva: anteponelo (`$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"`).

| Para | Comando | Notas |
|---|---|---|
| Dependencias | `npm ci` | Un worktree nuevo no tiene `node_modules` ni `target` (primer build Rust ~3 min) |
| Unit | `npm test` | cargo (app + relay) + vitest |
| End to end | `npm run test:e2e` | Instancia lateral real + relay real + CDP. Con dos corridas en paralelo, cada una con su `COUCOU_E2E_INSTANCE` |
| Input real | `npm run test:input` | **Mueve el mouse.** Solo con el escritorio libre y permiso de Manuel |
| Instalador | `npm run pack` | Deja `release/Coucou-Windows-<ver>-setup.exe` |

Correr las suites **también desde PowerShell**, no solo desde Git Bash: ya hubo un bug que
solo aparecía en PowerShell (`Path` vs `PATH`).

Para reinstalar: pedirle a Manuel que haga **Quit** desde la bandeja (el modo auto no deja
matar el proceso instalado), correr el instalador con `/S`, y relanzar con
`Start-Process "$env:LOCALAPPDATA\Coucou\coucou.exe" -WorkingDirectory "$env:LOCALAPPDATA\Coucou"`.
Si un cambio toca el comando de los hooks, Settings lo muestra como **Update…** y Manuel lo
aplica viendo el diff.

### Git

- `origin` = `manuanselmi/panita` (privado). `upstream` = `Louis-CFM/coucou`.
- Trabajo en ramas; los subagentes, en worktrees con rama propia. Se integran en una rama
  `integrationN`, se corren todas las suites y se mira el resultado antes de proponer el merge.
- **El merge a `main` y el push los hace Manuel**: el modo auto bloquea "merge without
  review". Dejale el comando listo para pegar con `!`:
  `git -C C:/Users/manua/Documents/GitHub/panita checkout main; git -C … merge --ff-only <rama>; git -C … push origin main`.
- Commits en inglés, prefijo `Windows:` (como upstream), cerrando con la línea
  `Co-Authored-By` que indique el sistema.
- GitHub Actions está **desactivado** en el repo: los workflows del upstream compilan en macOS
  y en un repo privado consumen minutos (x10).

### Subagentes

Funciona bien así: brief autocontenido con las restricciones duras de abajo, rama y worktree
propios, instancia e2e propia, y un reporte final con cambios de producción justificados,
conteos de tests reales y capturas. Antes de integrar: revisar a mano el diff de producción en
las partes sensibles (relay, escritura de `settings.json`, foco de ventanas) y **mirar las
capturas**.

## Reglas heredadas del upstream (siguen vigentes)

- **Nunca bloquear a Claude Code**: si la app no responde, el relay sale enseguida con stdout vacío.
- **Nunca aprobar un permiso sin un click explícito.**
- **Nunca escribir `~/.claude/settings.json` sin backup fechado, diff visible y click.**
- 0 % de CPU con la isla oculta. Sin telemetría. Red solo hacia servicios que el usuario configuró.
- Secretos en el Credential Manager, nunca en disco ni en git.
- Sin dependencias de runtime nuevas salvo que sean inevitables (las de desarrollo sí).
- El personaje se dibuja en código.

El fork **se aparta a propósito** del diseño de `design/captures/` en el layout de la isla
(D-005, D-006). El resto de lo visual sigue el diseño original.

## Convenciones de código

- Identificadores, comentarios y docs técnicas (`windows/*.md`) **en inglés**, como upstream.
- Texto visible: etiquetas de pasos y explicaciones de comandos **en español**; el resto de la
  interfaz sigue en inglés por ahora (D-012, pregunta I3).
- Rust edition 2021; front en TypeScript sin framework; tests con `cargo test` y `vitest`.
- El diccionario de comandos es `windows/src/core/explain.ts`: cómo agregar una regla está
  documentado arriba del archivo; cada regla lleva su fila en `windows/tests/unit/explain.test.ts`.
- Un test de regresión no se da por bueno hasta **verlo fallar sin el arreglo**.

## Confirmado vs. supuesto

En este proyecto la confusión sale cara porque gran parte del comportamiento depende de
Windows, VS Code y WSL, que no controlamos. Ejemplos de esta historia: que Windows dejara traer
una ventana al frente desde la isla era un riesgo `[SUPUESTO]` hasta que el log mostró
`set directly`; y un e2e pasó en verde con el bug del ticker presente porque usaba textos
cortos. Lo que dice un subagente es `[REPORTADO]` hasta verificarlo.

| Etiqueta | Qué significa |
|---|---|
| `[CONFIRMADO]` | Verificado (log, test que falla sin el arreglo, prueba supervisada en la máquina) |
| `[REPORTADO]` | Lo dijo un subagente, la documentación o alguien, pero no lo vimos |
| `[SUPUESTO]` | Inferencia nuestra. Puede estar mal |
| `[A VERIFICAR]` | Pendiente, y **tiene** entrada en `memoria/preguntas-abiertas.md` |

Nunca se sube de categoría sin evidencia, y al subir se anota cómo y cuándo.

## Protocolo de memoria

- **`memoria/decisiones.md`**: una entrada `D-NNN` por decisión estructural **o descarte**,
  con Contexto · Decisión · Consecuencias · Estado (`vigente` / `revertida` /
  `superada por D-NNN`). No se borra ni se reescribe: si cambia, se marca superada y se
  agrega otra.
- **`memoria/preguntas-abiertas.md`**: lo que no sabemos y condiciona algo, por severidad. Al
  resolverse se mueve a "Resueltas" con fecha y dónde quedó la respuesta. No se borra.
- **`memoria/bitacora/AAAA-MM-DD-titulo.md`**: una entrada por sesión que haya cambiado algo:
  Qué se hizo · Qué se aprendió · Qué se decidió · Qué queda pendiente. Ofrecela al cerrar.
- No va en la memoria lo que ya está en `windows/*.md` ni lo que se deduce de `git log`.

## Qué NO hacer

1. **No tocar la instalación real desde tests ni subagentes.** Nada de matar o reiniciar el
   `coucou.exe` instalado, ni escribir `%LOCALAPPDATA%\Coucou\`, `%APPDATA%\Coucou\`, las
   credenciales `fr.louisraille.coucou` o los `~/.claude/settings.json` reales (Windows y
   WSL). Para probar existe `COUCOU_INSTANCE` (ver `windows/TESTING.md`). Firme: un brief con
   un flag de `WSLENV` al revés habría mandado eventos de prueba a la app real (se detectó a tiempo).
2. **No lanzar Coucou desde una consola parada dentro del repo.** Hereda esa carpeta como
   directorio de trabajo y la deja bloqueada: no se puede renombrar ni borrar. Siempre con
   `-WorkingDirectory "$env:LOCALAPPDATA\Coucou"`.
3. **No simular mouse ni teclado ni robar el foco** en pruebas automáticas mientras Manuel
   trabaja en la máquina. Las pruebas por DOM (CDP) sí.
4. **No instalar ni tocar extensiones del VS Code de Manuel, ni abrir ventanas de VS Code,
   desde tests.** La instalación de la companion es un click suyo en Settings (o un pedido
   explícito).
5. **No publicar el fork ni builds** con el nombre Coucou o Mochi, el personaje, los íconos o
   los sonidos del autor (`LICENSE-ASSETS.md`). Privado está permitido. Para publicar hace
   falta identidad propia (pregunta N1).
6. **La app nunca lee, guarda ni usa credenciales de la suscripción de Claude.** El chat de la
   isla corre el `claude` oficial instalado en la PC, que maneja su propio login, en modo
   restringido y de solo lectura (D-016, que supera a D-013). Nada de llamar a la API con el
   token de la suscripción ni de sacarlo de donde Claude Code lo guarda.
7. **No cerrar una decisión estructural sin mostrar 2–3 opciones con sus trade-offs.** Manuel
   decide; vos recomendás.
8. **No reabrir lo descartado en `memoria/decisiones.md` sin un dato nuevo**, y no borrar
   decisiones ni preguntas.
