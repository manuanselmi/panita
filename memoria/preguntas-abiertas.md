# Preguntas abiertas

> Todo lo que no sabemos y condiciona alguna decisión.
> **Protocolo:** cuando una pregunta se responde, la respuesta se lleva a donde corresponda
> (`windows/*.md`, `decisiones.md`) y la pregunta se mueve a "Resueltas" con fecha. No se borra.

---

## 🔴 Bloqueantes — sin esto no se avanza

_(ninguna)_

## 🟡 Importantes — condicionan el diseño

### I1. ¿Cómo se traen los cambios del autor sin romper lo nuestro?
`windows/` divergió mucho (sesiones, WSL, extensión, explicaciones) y upstream sigue
commiteando. Hay que decidir la estrategia: merge periódico de `upstream/main` resolviendo a
mano, cherry-pick solo de arreglos del relay y del hook, o dejar de seguir upstream. Desbloquea:
con qué frecuencia y cómo actualizar. Hacer un `git fetch upstream` y medir cuánto conflictúa
antes de decidir.

**Medición del 2026-10-01** (`git fetch upstream`, merge de prueba con `git merge-tree`, sin
escribir nada): `upstream/main` está 25 commits adelante de la base común `835421c`. Solo 5
tocan `windows/` y son una sola feature: el campo `coucou_agent` para enrutar agentes de
terceros (Gemini CLI, Antigravity) a su propia píldora. Ninguno es un arreglo. El merge
conflictúa en 3 archivos: `windows/hook/src/main.rs` (parseo de argv: upstream agregó
`--agent`, nosotros `--wsl-ppid`), `windows/src/core/state.ts` y `windows/src/island/hooks.ts`.
El commit "Harden the hook socket and local logs" (`1f6e0d0`) es solo de macOS. Para el uso de
Manuel (solo Claude Code), esta tanda no aporta nada.

### I2. ¿Un segundo pedido de permiso debería esperar en cola en vez de volver a la terminal?
Hoy, si llega un pedido mientras otro está en pantalla, el segundo se rechaza en la isla (la
terminal pregunta como siempre) y su panita queda con un badge ámbar. Con varias sesiones
trabajando a la vez puede pasar seguido. Una cola respetaría "nunca bloquear" solo si el tiempo
total sigue acotado por el relay (110 s). Desbloquea: si vale la pena el cambio.

### I3. ¿Se traduce al español el resto de la interfaz?
Hoy: etiquetas y explicaciones en español; "needs permission", "Deny/Allow", "No other
sessions", Settings, en inglés (D-012). Desbloquea: consistencia de la UI.

### I4. ¿El click en una panita debería "pegarse" a la izquierda?
Con el orden por actividad (D-004) la sesión clickeada se va cuando otra hace algo después de
2 s. Si en el uso real molesta, la alternativa es fijarla hasta otro click o hasta que pida algo.
Desbloquea: posible ajuste a D-004.

### C1. ¿Dónde vive la carpeta hub del chat y qué dice su `CLAUDE.md`? (D-016)
Un repo aparte en esta PC, con un `CLAUDE.md` que describa los proyectos de Manuel y apunte a sus
`CLAUDE.md` y `memoria/`. Falta elegir ruta (¿`C:\Users\manua\Documents\GitHub\hub`?), qué
repos se le abren con `--add-dir` (¿todo `GitHub\`? ¿solo algunos?) y si el `CLAUDE.md` de
usuario de Manuel (sus preferencias de tono) también se le pasa. Desbloquea: implementar D-016.

### C2. ¿Con qué modelo chatea la isla? (D-016)
Por defecto Claude Code usa el de la cuenta (`claude-opus-5-5`, ~2 s por respuesta corta en el
proceso vivo). Uno más rápido abarata los límites compartidos con las sesiones de código.
Settings ya tiene un campo `model` (era para la API). Desbloquea: el default.

### C3. ¿Puede el chat leer proyectos que viven dentro de WSL? (D-016)
El proceso corre en Windows; las rutas `\\wsl.localhost\Ubuntu-24.04\…` en `--add-dir` no se
probaron. La mayoría de los repos están del lado Windows (`Documents\GitHub`). `[A VERIFICAR]`

## 🟢 Operativas — para el día a día

### O1. ¿Anda el botón Install/Update de la extensión en Settings con un click real?
La extensión se instaló por CLI (`code --install-extension … --force`); el botón solo está
probado en e2e contra un `code` falso. `[A VERIFICAR]` en la próxima actualización de la
extensión.

### O3. `npm run test:input` nunca se corrió
Mueve el mouse de verdad (hover en el borde, que un click no robe el foco). Correrlo con el
escritorio libre.

### O4. ¿Qué pasa con sesiones fuera de terminales de VS Code?
No se probaron: Windows Terminal, el panel de la extensión oficial de Claude Code en VS Code,
ventanas Remote-SSH o contenedores (la companion no contesta en esos remotos). Hoy caen en el
comportamiento de D-009.

### O5. ¿Cuándo cae la activación en "parpadeo" en vez de traer la ventana?
Siempre se vio `set directly`. La cadena de respaldo (`AttachThreadInput` → `FlashWindowEx`)
existe pero nunca se observó en uso real.

### O6. El test de ancestría del relay falla con `npm test` desde Git Bash
`procs::tests::the_test_process_has_a_live_ancestry_that_matches_toolhelp` (`hook/src/procs.rs`)
falló 3 de 3 veces corriendo `npm test` / `npm run test:rust` desde Git Bash el 2026-10-01, y pasó
siempre desde PowerShell y con `cargo test -p coucou-hook` directo en Git Bash. El mensaje:
`the parent of 7896 — left: None, right: Some(26380)`: un proceso de la cadena de ancestros ya
no está en la foto de Toolhelp que el test saca después de recorrerla. `[CONFIRMADO]` que no lo
causó la rama `island-drag` (no toca `hook/`). `[SUPUESTO]`: algún proceso intermedio de npm o
de MSYS termina mientras el test corre, y el test asume que todos los ancestros siguen vivos.
Desbloquea: confiar en las suites corridas desde Git Bash; quizá el test tenga que tolerar un
ancestro que termina (el recorrido en producción ya corta ahí).

## 🔵 Del producto

### N1. ¿Se publica algún día?
Si sí, hace falta nombre, personaje, ícono y sonidos propios (`LICENSE-ASSETS.md`), y firmar el
instalador para que Defender no lo marque. Mientras sea privado, no aplica.

---

## Resueltas

### O2. Limpieza pendiente del disco y de ramas — resuelta 2026-10-01
Pendiente original: los worktrees de subagentes en `panita/.claude/worktrees/` (`sessions`,
`wsl-and-focus`, `terminal-focus`, `island-ui`, uno `locked`), las ramas locales ya mergeadas
y la carpeta vieja `C:\Users\manua\Documents\GitHub\coucou`.

Qué se hizo, con el OK de Manuel: antes de borrar se verificó que los cuatro worktrees no
tuvieran cambios ni stashes y que todas las ramas fueran ancestro de `main`. Lo único ignorado
eran builds (`target/`, `node_modules/`, `src-tauri/gen/`) y capturas de e2e, que se regeneran.
El lock de `island-ui` era viejo: lo había puesto el subagente con PID 23928, que ya no existía.
Se hicieron `git worktree unlock` y `git worktree remove` de los cuatro, y `git branch -d`
(no fuerza) de las 12 ramas mergeadas. Queda solo `main`. La carpeta `coucou` ya no existía.
