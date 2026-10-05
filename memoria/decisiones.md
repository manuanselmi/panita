# Registro de decisiones

> Una entrada por decisión. **Las decisiones descartadas quedan registradas con su
> razonamiento**: el descarte es información tan valiosa como la decisión, y evita re-litigar
> lo mismo dentro de tres meses.
>
> Formato: `## D-NNN — Título` · Fecha · Estado · Contexto · Decisión · Consecuencias.
> Estados: `vigente` · `revertida` · `superada por D-NNN`.

---

## D-001 — El repo guarda su memoria en `memoria/` y un `CLAUDE.md` propio del fork

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** El repo nació como clon de Coucou con el `CLAUDE.md` del autor, que describe la
app de macOS (Swift, Xcode) y no dice nada del port de Windows, que es lo único que se trabaja
acá. Manuel quiere que cada sesión nueva levante el contexto leyendo el repo.

**Descartada — un `docs/` propio como fuente de verdad.** `docs/` ya es el sitio de GitHub
Pages del upstream (privacy, terms, support). Mezclar ahí documentación del fork ensucia cada
merge con upstream. La documentación técnica ya vive en `windows/README.md` y
`windows/TESTING.md`, mantenidos junto al código.

**Descartada — `windows/CLAUDE.md` dejando intacto el de la raíz.** Las sesiones se abren en
la raíz, así que el que se carga al arrancar es el de la raíz, y el del autor confunde
(Swift, `xcodebuild`, bundle id de macOS).

**Descartada — reescribir el `README.md` raíz.** Es la cara del proyecto del autor y lo edita
seguido: tocarlo garantiza conflictos con upstream. El `CLAUDE.md` alcanza para orientar.

**Decisión.** `CLAUDE.md` raíz reescrito para el fork (en español, con las reglas heredadas
del upstream que siguen vigentes) y `memoria/` en la raíz con decisiones, preguntas y bitácora.

**Consecuencias.** Al traer cambios de upstream, `CLAUDE.md` va a conflictuar: se resuelve
quedándose con el nuestro y absorbiendo a mano lo que cambie en las reglas del autor.

---

## D-002 — Fork privado con historial completo, `upstream` como remote, instalado desde fuente

**Fecha:** 2026-09-30 · **Estado:** vigente

**Contexto.** No hay instalador de Windows publicado: el autor lo retiró porque Defender lo
marcaba (`Trojan:Win32/Wacatac.H!ml`, según él falso positivo) `[REPORTADO]`. Se compiló desde
fuente (Rust, VS Build Tools 2022 C++, Node) y se revisó el código antes: relay, pipe y red
solo hacia servicios configurados. Después Manuel quiso modificarlo. Licencias: el código es
MIT; el nombre, el personaje, los íconos y los sonidos son del autor con todos los derechos
reservados (`LICENSE-ASSETS.md`).

**Descartada — copiar solo el último commit a un repo nuevo.** Se pierde poder traer los
arreglos del autor, que commiteaba varias veces por día (muchos sobre el hook).

**Descartada — fork de GitHub.** El fork de un repo público no puede ser privado.

**Descartada — parches locales sobre el clon.** Sin versionado y en conflicto con cada `pull`.

**Decisión.** Repo nuevo privado `manuanselmi/panita` con todo el historial; `origin` es el
nuestro y `upstream` el del autor. GitHub Actions desactivado (los workflows del autor
compilan en macOS y en privado gastan minutos ×10). Solo se subió `main`, sin los tags del autor.

**Consecuencias.** Uso privado permitido por la licencia de assets. Publicarlo exige nombre,
personaje, ícono y sonidos propios (pregunta N1). Por dentro la app sigue llamándose Coucou.

---

## D-003 — Las pruebas usan una instancia lateral (`COUCOU_INSTANCE`) y nunca tocan la real

**Fecha:** 2026-09-30 · **Estado:** vigente · **Firme, no negociable por conveniencia**

**Contexto.** La app es de instancia única y usa un pipe por usuario; probar la versión de
desarrollo chocaba con la instalada. El modo auto bloqueó matar el `coucou.exe` instalado
("interfere with workloads"), con razón: Manuel trabaja con él abierto.

**Descartada — cerrar y reabrir la app real en cada prueba.** Interrumpe el trabajo, necesita
permiso cada vez y arriesga dejar a Claude Code sin relay.

**Decisión.** `COUCOU_INSTANCE=<nombre>`, leída por la app y por el relay, mueve pipe,
carpetas, credenciales, identifier de Tauri y entrada de autostart. Sin la variable todo queda
idéntico byte a byte (hay test). El e2e levanta una instancia lateral, habilita DevTools solo
en su WebView2 y la maneja por CDP sin mover el mouse. `COUCOU_TEST_HOME` (solo en instancias
laterales) redirige los `settings.json` a un sandbox. Detalle en `windows/TESTING.md`.

**Consecuencias.** Durante un e2e aparece una segunda isla arriba de la real por ~1–2 min. Dos
corridas en paralelo necesitan nombres distintos (`COUCOU_E2E_INSTANCE`): una vez dos
subagentes con el mismo nombre se pisaron las carpetas.

---

## D-004 — Una sesión por `session_id`, ordenadas por actividad reciente

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Upstream tenía una única tarea para todas las sesiones: con varias, los pasos se
mezclaban, el nombre saltaba y "Open" iba a la que habló última. Manuel tiene hasta ~5 sesiones
a la vez.

**Descartada — tarjetas fijas mientras la sesión esté activa** (lo que recomendó Claude: sin
saltos). Manuel eligió "siempre las más recientes".

**Decisión.** Una sesión por `session_id` (si falta, por `cwd`). Nombre = carpeta del primer
`cwd` visto (no cambia con `cd`). Color fijo de una paleta de 8, distinto entre sesiones vivas.
Se va con `SessionEnd` o tras 60 min sin eventos (vuelve con su próximo evento). Orden por
actividad reciente con una espera mínima de 2 s entre reordenamientos; el orden se congela
mientras el puntero está sobre la isla abierta; un pedido de permiso pasa la sesión adelante al
instante; un click en una panita también.

**Consecuencias.** Un click en una panita dura poco a la izquierda: cualquier otra sesión que
haga algo después de 2 s la desplaza (pregunta I4).

---

## D-005 — Layout v1: sesión principal + segunda sesión + panitas

**Fecha:** 2026-10-01 · **Estado:** superada por D-006

**Contexto.** La isla mide 640×160. Opciones evaluadas: (a) principal con Mochi grande a la
izquierda, y a la derecha la segunda sesión en una línea más las demás como panitas; (b) dos
tarjetas iguales y una fila de panitas abajo; (c) tres columnas.

**Descartada — (b).** La isla crecía a ~210 px de alto y se perdía el Mochi grande.

**Descartada — (c).** Tarjetas de ~200 px: textos demasiado cortados.

**Decisión.** (a).

---

## D-006 — Layout v2: la tarjeta derecha es solo panitas; nombres repetidos se numeran

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Usando v1, Manuel prefirió no destacar una segunda sesión: quiere ver a todas
como panitas. Además tenía tres sesiones en `struxto-especificador` imposibles de distinguir.

**Decisión.** A la izquierda, la sesión principal (Mochi grande, ticker de 2 líneas). A la
derecha, todas las demás como panitas en grilla: 1–3 en una fila, 4 = 2+2, 5 = 3+2, 6 = 3+3,
7 o más = 5 + "+N". Si dos sesiones vivas comparten nombre, se numeran ("… 2", "… 3") con el
menor número libre; el número nunca se corta al truncar el nombre y no pasa de una sesión a
otra. El tooltip de cada panita muestra nombre completo, carpeta (y distro) y el primer prompt.

---

## D-007 — Integraciones apagadas por defecto

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Upstream activaba Resend, n8n, Vercel y GitHub por defecto. Manuel no usa
ninguna y la tarjeta derecha pasó a ser de las sesiones.

**Decisión.** `activeIntegrations` arranca vacío (en `state.ts` y en `settings.rs`). Siguen
disponibles en Settings; si se activan, aparecen como panitas después de las sesiones.

---

## D-008 — Hooks también dentro de WSL, instalados por distro con el mismo consentimiento

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Las sesiones dentro de WSL leen el `~/.claude/settings.json` de Linux, así que
Coucou no las veía.

**Decisión.** Settings muestra una fila por destino ("Windows", "WSL · <distro>"), con el
mismo flujo de diff, backup fechado y click. Las distros salen del registro (`Lxss`); el home y
la ruta Linux del relay se le preguntan a la distro (`wslpath -u`); se escribe por
`\\wsl.localhost` y se rechazan symlinks. El comando instalado es
`'<relay>' <Evento> --wsl-distro "$WSL_DISTRO_NAME" --wsl-ppid "$PPID"`. Si el comando
instalado difiere del actual, la fila ofrece **Update…**.

**Consecuencias.** Claude Code lee los hooks al arrancar: las sesiones abiertas antes de un
cambio siguen con el comando viejo hasta reiniciarlas. `[CONFIRMADO 2026-10-01]` instalado
en `Ubuntu-24.04`, backup al lado, dueño `manua:manua` y modo `644` intactos.

---

## D-009 — "Open" enfoca la ventana de VS Code que ya existe

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Upstream hacía `code <cwd>`, que abre una ventana nueva salvo que esa carpeta
exacta sea la raíz de una ventana existente.

**Decisión.** Se enumeran las ventanas de `Code.exe` (también las de otros escritorios
virtuales) y se elige por título: la carpeta del `cwd` y después sus padres, deteniéndose
**debajo de la carpeta home** (nunca matchea "manua", "Users" ni "home"); una sesión WSL solo
matchea `[WSL: <su distro>]`. Activación: `SetForegroundWindow` → `AttachThreadInput` →
`FlashWindowEx`, sin simular input ni APIs no documentadas. Si Windows no deja traerla al
frente, no se abre otra ventana. Si no hay ventana, `code <cwd>` (o `--folder-uri
vscode-remote://wsl+…` para WSL).

**Consecuencias.** `[CONFIRMADO 2026-10-01]` funciona, incluido el cambio de escritorio
virtual (log: `cloaked: another virtual desktop — set directly`; Manuel: "10 puntos").

---

## D-010 — La pestaña exacta se enfoca con una extensión companion de VS Code y un pipe por ventana

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** VS Code no tiene CLI para enfocar una terminal de una ventana abierta.

**Descartada — B: extensión + link `vscode://`.** VS Code pide confirmar el link la primera vez
y lo entrega a la ventana activa: frágil con varias ventanas.

**Descartada — C: simular teclas.** Frágil, toma el teclado y no sabe cuál pestaña es.

**Decisión.** Extensión `coucou.terminal-focus` (`windows/vscode-extension/`, sin dependencias,
`extensionKind: ui`): cada ventana sirve `\\.\pipe\coucou-vscode-<pid>-<hex>`. El relay manda
sus PIDs ancestros con `NtQueryInformationProcess` (~16 µs `[REPORTADO]` por el subagente que
lo midió; se descartó Toolhelp, 11,6 ms por evento) y, en WSL, `$PPID`; la app los guarda por sesión. Al hacer click consulta todas las
pipes del mismo usuario; la ventana que tiene la terminal hace `terminal.show()` y devuelve su
nombre, y después se trae esa ventana. Si nadie contesta, todo queda como en D-009. El `.vsix`
viaja con la app y Settings tiene Install/Update.

**Consecuencias.** `[CONFIRMADO 2026-10-01]` funciona en Windows y en Remote-WSL (log:
`terminal "✳ coucou instalación" focused in "GitHub"`). VS Code activó la extensión sin
recargar. Se instaló por CLI, no con el botón (pregunta O1).

---

## D-011 — La tarjeta de permiso explica el comando con un diccionario propio

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Manuel quiere saber qué hace un comando antes de aprobarlo (`Push de "main" a
"dev"`, `Commit en "dev"`, `Moverse de carpeta`, `Eliminar algo`) y ampliar el diccionario con
el tiempo.

**Decisión.** `windows/src/core/explain.ts`: reglas ordenadas (patrón → plantilla), cadenas
unidas con " → ", lo desconocido no muestra nada, lo peligroso va en rojo con ⚠. La rama de un
commit o push se pide después del ack con un comando Rust (`git -C <carpeta> rev-parse`, sin
shell, 2,5 s). La tarjeta pasa de 160 a 176 px.

**Descartada — en WSL, `wsl.exe --cd <carpeta> git …`.** Si la carpeta no existe, WSL avisa y
corre igual en otra, y podría dar la rama de otro repo. Se usa `--cd / --exec git -C <carpeta>`.

---

## D-012 — Etiquetas y explicaciones en español; el resto de la interfaz en inglés por ahora

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** Upstream tenía las etiquetas de pasos en francés ("Exécute", "Lit") y la
interfaz en inglés.

**Decisión.** Etiquetas ("Ejecuta", "Lee", "Edita"…) y explicaciones de comandos en español.
La traducción del resto queda abierta (pregunta I3).

---

## D-013 — El chat de la isla no se configura

**Fecha:** 2026-09-30 · **Estado:** superada por D-016

**Contexto.** El chat y las preguntas sobre archivos llaman a la API de Anthropic con API key
(pago por uso, aparte de la suscripción). Ver sesiones y aprobar permisos no la necesita.

**Descartada — usar la cuenta de la suscripción de Claude.** La app no lo soporta y el login de
la suscripción no está permitido en apps de terceros.

**Decisión.** Sin API key por ahora; Manuel chatea con Claude por la terminal o claude.ai.

---

## D-014 — Los merges a `main` los hace Manuel; Claude entrega ramas integradas y probadas

**Fecha:** 2026-10-01 · **Estado:** vigente

**Contexto.** El modo auto bloquea "merge without review" (merge a `main` + push).

**Decisión.** Claude integra en una rama `integrationN`, resuelve conflictos, corre todas las
suites desde PowerShell, mira las capturas y deja el comando para que Manuel lo pegue con `!`
(`checkout main; merge --ff-only <rama>; push origin main`).

## D-015 — La isla se puede arrastrar por el borde de arriba; doble click en el header la achica

**Fecha:** 2026-10-01 · **Estado:** vigente el arrastre; el plegado (doble click, y no sobre un
permiso) superado por D-018

**Contexto.** Centrada arriba, la isla le tapa a Manuel lo que tiene en esa zona de la
pantalla. Además, para achicarla había que esperar el cierre automático (15 s): `Esc` casi
nunca llega, porque la ventana no toma el foco del teclado salvo en el chat (`WS_EX_NOACTIVATE`)
`[SUPUESTO]`, por lectura del código; no se probó a mano.

**Decisión.** Elegida por Manuel entre dos opciones:
- **Arrastre libre, solo horizontal**, pegada al borde superior y dentro del mismo monitor, con
  **imán al centro** (a menos de 24 px del medio vuelve al centro: es la forma de volver sin un
  botón de reset). La posición se guarda en `settings.json` como `island_x` (fracción del ancho
  del monitor, para que sobreviva a cambios de resolución, de escala y a la opción "monitor del
  cursor") y vuelve ahí al reiniciar.
- Se agarra la isla compacta entera, o la abierta por la franja vacía del header (entre las
  pestañas y el engranaje). Esa misma franja con **doble click** pliega la isla a compacta.

**Descartada — tres posiciones fijas (izquierda, centro, derecha) con salto a la más cercana.**
Más prolija, pero la posición fija de la derecha puede tapar otra cosa, que es justo el problema.

**Cómo funciona** (detalle en el código, `src-tauri/src/island.rs`):
- La isla se ubica por su *ancla*: el centro, en px lógicos desde el borde izquierdo del
  monitor. La ventana de 720 px se centra en el ancla pero nunca se sale del monitor; cerca de
  un borde la ventana se frena y la isla se corre adentro de ella (Rust manda ese centro al front
  con el evento `island-anchor`). Así queda pegada al borde y al abrirse crece hacia el medio.
- El arrastre lo maneja Rust desde el hilo que ya lee el cursor a 60 Hz, con `GetCursorPos` y
  `GetAsyncKeyState`: cuando la isla se frena contra un borde el puntero se le sale, la ventana
  vuelve a ser "click-through" y la página deja de ver el mouse. El front solo avisa el
  mousedown (`island_press`).
- Click vs. arrastre: pasar de 4 px lógicos es arrastre. Por eso la compacta ahora **se abre al
  soltar, no al apretar** (un cambio de sensación casi imperceptible).
- `island_x` lo escribe **solo** el arrastre: `save_settings` conserva el valor guardado, porque
  la isla y la ventana de Settings mandan copias completas de los settings que pueden ser
  anteriores al arrastre y lo pisarían.

**Descartada — una ventana transparente del ancho de todo el monitor**, con la isla movida solo
por CSS. Más simple de dibujar, pero mientras el botón está apretado sobre la ventana, esta toma
el mouse (lo necesita el drop de archivos): una franja de 320 px en todo el ancho de arriba
interferiría con pestañas y barras de título de otras apps.

**Consecuencias.** Se aparta otra vez del diseño original (la isla del Mac vive en el notch y no
se mueve). El doble click no pliega la isla con una tarjeta de permiso esperando (misma regla que
`Esc`): plegada, nadie podría contestarla hasta que el relay se rinda.

## D-016 — El chat de la isla corre Claude Code (el `claude` oficial), vivo, restringido y de solo lectura

**Fecha:** 2026-10-01 · **Estado:** vigente · **Supera a:** D-013

**Contexto.** D-013 dejó el chat sin configurar: la app solo sabe hablar con la API con API key
(pago aparte) y se descartó usar la suscripción. Manuel quiere chatear desde la isla con un
Claude que conozca sus proyectos, y usa Claude Code con su suscripción todo el día. El dato nuevo
que reabre D-013: la app no necesita tocar ninguna credencial; puede lanzar el `claude` oficial
que ya está instalado (2.1.287 en Windows, `~/.local/bin/claude.exe`) en modo sin interfaz y
mostrar sus respuestas. El que habla con Anthropic es Claude Code, con su propio login.

**Política.** Lo único explícito en la documentación es: *"Unless previously approved, Anthropic
does not allow third party developers to offer claude.ai login or rate limits for their products,
including agents built on the Claude Agent SDK."*
(https://code.claude.com/docs/en/agent-sdk/overview.md, `[REPORTADO]` por la consulta a la doc del
2026-10-01). Apunta a desarrolladores que ofrecen el login de la suscripción en su producto. Este
caso — una app privada que corre el CLI oficial en la PC de su dueño, para él — no aparece ni
permitido ni prohibido. `[SUPUESTO]`: está dentro del uso personal de Claude Code en modo `-p`,
que existe para scripts. Manuel lo aceptó sabiendo que no es explícito. Si la app se publicara
algún día (N1), esto se revisa.

**Opciones que se mostraron.**
- **A. Chat en la isla vía `claude -p`** — elegida, en su variante de proceso vivo.
- **B. "Ask" abre una terminal de VS Code con `claude` en la carpeta hub.** Sin gris de política
  y con Claude Code completo, pero el chat no vive en la isla. Descartada: Manuel quiere el chat
  en la isla.
- **C. Seguir con la API key (D-013).** Pago aparte y sin contexto de los proyectos.
- Dentro de A: **un proceso por mensaje** (`--resume` cada vez: ~4 s de arranque en cada
  mensaje) contra **un proceso vivo** alimentado por stdin. Elegido el vivo.

**Decisión.**
- **Un solo proceso de chat para toda la app.** Arranca con el primer mensaje (no al abrir
  Coucou: no ocupa memoria si no se chatea), queda vivo entre mensajes, "+" empieza una
  conversación nueva (cierra el proceso y arranca otro con otro id), Quit lo cierra. Si se cae
  (una actualización de Claude Code, un error), la app lo relanza con `--resume <id>` y la
  conversación sigue.
- **La app elige el id** (`--session-id <uuid>`), así sabe de antemano qué sesión es la suya.
- **Restringido y de solo lectura:** `--restricted` (sin herramientas que ejecutan comandos,
  archivos limitados a la carpeta de trabajo y a los `--add-dir`, ignora los settings de usuario,
  proyecto y local — y con ellos los hooks —, rechaza `bypassPermissions`), `--strict-mcp-config`
  (sin conectores de claude.ai), `--permission-mode dontAsk` y `--permission-prompts none` (lo
  que pediría permiso se niega solo: nada se aprueba sin un click de Manuel, porque no se aprueba
  nada), y la lista de herramientas acotada a leer y buscar (Read, Glob, Grep, WebSearch,
  WebFetch).
- **Contexto:** el proceso corre en una carpeta "hub" — un repo aparte, a definir, con un
  `CLAUDE.md` que describe los proyectos de Manuel —, que se le pasa explícitamente con
  `--append-system-prompt-file`, y los repos de los proyectos con `--add-dir`.
- **La app nunca lee ni guarda credenciales de Claude Code.** El camino con API key puede quedar
  como alternativa; se decide al implementar.

**Evidencia — prueba del 2026-10-01** (`claude` 2.1.287, modelo por defecto `claude-opus-5-5`,
suscripción de Manuel; carpeta hub de juguete con un `CLAUDE.md` con una palabra clave):
- `[CONFIRMADO]` El proceso vivo anda: una línea por mensaje en stdin,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`, y en stdout
  los eventos `system/init`, `assistant`, `result` de `--output-format stream-json --verbose`.
  Al cerrar stdin el proceso sale con código 0.
- `[CONFIRMADO]` Tiempos: arranque hasta `init` ~1,4 s; primer mensaje 7,6 s (el modelo hizo
  dos lecturas de archivo); **segundo mensaje en el mismo proceso 2,1 s**; reanudar con
  `--resume` en un proceso nuevo 3,7 s; un `-p` suelto sin herramientas 4,4–5,9 s.
- `[CONFIRMADO]` Memoria del proceso vivo: ~220 MB (los Claude Code interactivos de Manuel, con
  horas de uso: ~350 MB).
- `[CONFIRMADO]` La conversación sigue entre mensajes del mismo proceso y después de `--resume`.
- `[CONFIRMADO]` Con `--restricted` (y también con `--setting-sources project,local`) no se
  disparó ningún hook de Coucou: el log real no tuvo ninguna línea de esas sesiones.
- `[CONFIRMADO]` **`--restricted` no carga el `CLAUDE.md` solo** (el modelo contestó que no lo
  tenía, y en la primera prueba lo buscó con Glob y Read); con
  `--append-system-prompt-file CLAUDE.md` sí lo tiene.
- `[CONFIRMADO]` Sin `--tools`, el modo restringido igual ofrece Edit, Write, NotebookEdit, Task,
  Cron*, ScheduleWakeup, SendMessage, EnterWorktree y otras: por eso la lista acotada.
- El costo que informa cada respuesta (~0,05 USD por turno con Opus) es una estimación del
  cliente; con la suscripción no se cobra aparte, pero cuenta contra sus límites, compartidos con
  las sesiones de código de Manuel.

**Consecuencias.** La regla 6 de `CLAUDE.md` cambia: lo prohibido es que la app use o guarde
credenciales de la suscripción, no que corra el CLI oficial. Quedan para la implementación las
preguntas C1–C3 de `preguntas-abiertas.md` (la carpeta hub, el modelo, los proyectos en WSL).

---

## D-017 — El chat no puede leer secretos ni datos de clientes

**Fecha:** 2026-10-05 · **Estado:** vigente

**Contexto.** Con C1 el chat puede leer todo `Documents\GitHub`. El relevamiento de ese día para
el hub encontró ahí unos 15 `.env`, un archivo de credenciales suelto
(`Hekta\metaagent\.aerodol_creds`) y datos de clientes: un dump SQL de 60 MB, 2,1 millones de
transacciones de usuarios de Ahorra Fácil, la base exportada de Aerodol. Lo que el chat lee
viaja a Anthropic dentro de la conversación. Manuel eligió bloquearlo (también registrado como
D-003 del hub).

**Decisión.** `chat_cc.rs` escribe un `--settings` con reglas `Read(...)` de denegación para
secretos (`.env*`, `*creds*`, `*credential*`, `*secret*`, `*cookies*`, `id_rsa*`, `*.pem`,
`*.key`, `*.pfx`, `*.p12`) y datos (`*.sql`, `*.db`, `*.sqlite*`, carpetas `datos/` y `tablas/`),
una tanda por cada disco de las carpetas que el chat puede leer. Amplio a propósito: bloquear un
`.env.example` no cuesta nada; un `.env` leído no se puede deshacer. `--restricted` ignora los
settings de usuario pero sí aplica los de `--settings`.

**Evidencia — prueba del 2026-10-05** con el `claude` real (2.1.287), archivos señuelo con
marcadores en una carpeta `--add-dir`, pidiéndole que los lea y que los busque con Grep:
- `[CONFIRMADO]` **La forma documentada no bloquea nada en Windows:** con `Read(**/.env)` leyó
  los 7 señuelos. Tampoco `Read(//C:/Users/…/**/.env)`, con la letra y los dos puntos.
- `[CONFIRMADO]` Bloquean todo `Read(~/**/.env)` (relativo al home) y `Read(//c/Users/…/**/.env)`
  (letra en minúscula, sin dos puntos). Se usa la segunda, desde la raíz del disco
  (`//c/**/.env`), que cubre cualquier carpeta configurada y no solo las del home.
- `[CONFIRMADO]` Con las reglas puestas, Grep tampoco encontró el contenido de esos archivos, y un
  archivo permitido (`README.md`) se leyó normal.

**Descartada — confiar en que el modelo no los lea.** Pidiéndoselo, los leyó sin dudar.

**Descartada — achicar las carpetas legibles.** Manuel quiere que el chat vea todos sus
proyectos (C1); el problema son algunos archivos, no las carpetas.

**Consecuencias.** Una carpeta sin letra de disco (un `\\wsl.localhost\…`) no tiene reglas: si
algún día se agrega una (C3), hay que resolverlo antes. Si una versión nueva de Claude Code
cambia cómo interpreta los patrones, el bloqueo podría dejar de funcionar sin que nada falle:
`windows/TESTING.md` deja la prueba con señuelos para repetirla a mano.

---

## D-018 — Las preguntas de Claude no son permisos; la tarjeta de permiso crece y tiene ↗; un click en el header pliega la isla siempre

**Fecha:** 2026-10-05 · **Estado:** vigente · **Supera a:** D-015 en el plegado (el arrastre
sigue vigente)

> Numerada D-018 porque la rama `chat-deny` (otra sesión, sin commitear al escribir esto) ya
> tiene una D-017. Si al integrar el número choca, se renumera la que entre segunda.

**Contexto.** Pedido de Manuel, con una captura: (1) cuando Claude pregunta con
`AskUserQuestion`, la isla mostraba una tarjeta de permiso que decía solo "AskUserQuestion" con
Deny / Allow, sin la pregunta; (2) la explicación del comando se cortaba en "…" a un renglón;
(3) no podía cerrar la isla con una tarjeta abierta. Datos nuevos, que reabren lo que D-015 dejó
dicho ("plegada, nadie podría contestarla hasta que el relay se rinda"):
- `[CONFIRMADO]` leyendo el binario de Claude Code 2.1.289 (`~/.local/bin/claude.exe`): ante un
  permiso, Claude Code corre el hook `PermissionRequest` **y muestra su diálogo en la terminal al
  mismo tiempo** (`Promise.race([hook, diálogo])`); gana el primero. La terminal pregunta desde
  el primer momento, esté la isla abierta, plegada o colgada.
- `[CONFIRMADO]` mismo binario: si el hook devuelve "allow" **sin `updatedInput`** para una
  herramienta que pide interacción del usuario, la decisión del hook se ignora y sigue el
  diálogo. `AskUserQuestion` es una de las (dos) herramientas a las que un hook puede contestar
  con `updatedInput`; la otra, por el nombre minificado, sería `ExitPlanMode` `[SUPUESTO]`.
  `[SUPUESTO]` fuerte: `AskUserQuestion` declara que pide interacción (no se llegó a leer).
  O sea: el Allow de la isla para una pregunta no hacía nada, y el Deny se la rechazaba a Claude.
- `[CONFIRMADO]` en el log: el `AskUserQuestion` del 2026-10-05 11:57 (id `30600-14`) estuvo
  108 s en la isla sin respuesta y se contestó en la terminal.

**Decisión.**
1. **`AskUserQuestion` no pasa por la tarjeta de permiso.** El pedido se devuelve al instante
   (decline: el relay sale vacío y la terminal, que ya la muestra, sigue) y la isla abre una
   **tarjeta de pregunta** sobre esa sesión: la primera pregunta (hasta dos renglones), sus
   opciones, "+N more questions", **Open terminal** y **OK**. Se va sola cuando llega el
   `PostToolUse` / `PostToolUseFailure` de `AskUserQuestion` de esa sesión, o termina el turno
   (`UserPromptSubmit`, `Stop`); no con cualquier herramienta, porque un subagente de la misma
   sesión puede seguir trabajando mientras la pregunta espera. Nunca tapa una tarjeta de
   permiso: en ese caso la sesión queda con el badge ámbar.
2. **La tarjeta de permiso tiene ↗** (arriba a la derecha, como la tarjeta izquierda del
   overview) a la sesión que pide. La tarjeta queda arriba: se puede contestar en cualquiera de
   los dos lados.
3. **La explicación ocupa hasta tres renglones**, y la isla crece 15 px por renglón extra; pasado
   eso, "…" (el texto completo sigue en el tooltip). Los renglones se cuentan sobre una copia
   oculta al ancho de la isla abierta (`CARD_TEXT_W` en `layout.ts`), no sobre la fila visible,
   que es más angosta mientras la isla se abre. El e2e verifica que la fila real mida eso.
4. **Un click** (no doble) en la franja vacía del header pliega la isla, muestre lo que muestre;
   `Esc` hace lo mismo. Si hay una tarjeta de permiso, el pedido se devuelve a la terminal
   (decline) y el panita de esa sesión queda con badge ámbar hasta que haga otra cosa. Cerrar =
   "lo contesto en la terminal".

**Descartadas.**
- *Dejar Deny / Allow en `AskUserQuestion` y solo sumar ↗* (lo literal del pedido): Allow no
  hace nada y Deny le rechaza la pregunta a Claude; dejar esos botones es una trampa.
- *Plegar dejando el permiso pendiente*, con la tarjeta volviendo al reabrir: conserva aprobar
  desde la isla, pero deja estado escondido hasta 110 s y reabre sobre algo que el usuario
  cerró. Como la terminal ya pregunta, devolverlo no pierde nada.
- *Altura fija más alta para la tarjeta de permiso*: más simple, pero deja aire de sobra en el
  caso común de un renglón.
- *Seguir con doble click* (D-015): Manuel pidió click. El primer click de un doble click ya
  pliega; el segundo no reabre la isla (500 ms de guarda, `REOPEN_GUARD_MS`).
- *Contestar la pregunta desde la isla* eligiendo una opción: parece posible (dato de arriba), pero
  el formato de `updatedInput` para `AskUserQuestion` no está documentado. Queda como pregunta I5.

**Consecuencias.** Un permiso que se contesta en la terminal sigue dejando la tarjeta arriba
hasta los 110 s del relay; ahora al menos se cierra con un click (pregunta O7). Si una versión
futura de Claude Code dejara de mostrar el diálogo en paralelo, plegar sobre un permiso seguiría
siendo seguro (el decline hace que pregunte la terminal) pero volvería a tener sentido revisarlo.

---

## D-019 — Pegar una imagen en el chat la guarda en el inbox y va con el próximo mensaje

**Fecha:** 2026-10-05 · **Estado:** vigente

**Contexto.** Manuel: "no puedo pegar imágenes al chat de panita". La caja del chat era un
`<input>` de texto sin manejo de pegado: un `Ctrl+V` de imagen se perdía. Lo único que existía
era arrastrar un archivo a la isla (se copia al inbox, Claude Code lo lee con `Read`), y solo
viajaba con el primer mensaje de la conversación.

**Decisión.** Un `Ctrl+V` con una imagen (PNG, JPEG, GIF, WebP; hasta 25 MB) la guarda en el
inbox como `pegada-<fecha>-<hora>.<ext>` (comando `paste_image`, con los bytes como cuerpo crudo
del pedido, no como JSON), la muestra como chip y la manda con el **próximo** mensaje, sea el
primero o no. Lo decide la isla (`State.pendingFile`): Rust manda el contexto cada vez que lo
recibe, en los dos motores (Claude Code y API). El mensaje dice "The user attached a file to this
message: …", para archivos arrastrados y pegados por igual.

**Descartada — mandar la imagen dentro del mensaje** como bloque de imagen del stream-json.
Ahorraría la llamada a `Read`, pero no se verificó que el CLI la acepte en `-p --input-format
stream-json`, y probarlo gasta la suscripción. Si pegar resulta lento, es el siguiente paso.

**Consecuencias.** Una imagen por mensaje: un segundo pegado antes de mandar reemplaza al
primero. La imagen pasa por las reglas de lectura de D-017 como cualquier archivo del inbox (un
nombre `pegada-…` no las toca). El inbox se barre a la semana, como siempre.

---

## D-020 — El uso de 5 horas llega por la status line de Claude Code y se ve en la isla

**Fecha:** 2026-10-05 · **Estado:** vigente

**Contexto.** Manuel quiere ver el uso del límite de 5 horas de la suscripción en la isla:
arriba, en la franja del header, y también con la isla compacta. La regla 6 de `CLAUDE.md`
prohíbe que la app use las credenciales de la suscripción, así que no se puede preguntar a la API
de uso de Anthropic. Dato nuevo `[CONFIRMADO]` leyendo el binario de Claude Code 2.1.289: el JSON
que Claude Code le pasa a un comando de **status line** trae `rate_limits.five_hour` y
`rate_limits.seven_day` (`used_percentage`, `resets_at`) — solo a suscriptores, después de la
primera respuesta de la API, y solo mientras la ventana no se reinició. Los hooks no lo reciben.

**Decisión** (Manuel eligió la opción 1 de tres):
- El mismo flujo de instalación (backup, diff, click) escribe una `statusLine` en
  `~/.claude/settings.json` de Windows y de cada distro: `coucou-hook StatusLine`. El relay la
  reenvía como un evento más y **no imprime nada**, así que la terminal no muestra status line
  (Manuel no eligió; se tomó el default más discreto y se cambia en una línea).
- La app (`pipe.rs`, `usage_of`) se queda solo con las dos ventanas y le manda a la isla un evento
  `usage`; no lo loguea (llega cada pocos segundos) y no crea ni toca sesiones.
- La isla muestra una barra finita y el porcentaje del límite de 5 horas: centrada en la franja
  del header con la isla abierta, y en el centro de la isla compacta. Ámbar desde 80 %, rojo
  desde 95 %; el tooltip dice a qué hora se reinicia y el uso semanal. Oculta hasta el primer
  dato y cuando la ventana se reinicia.
- Una `statusLine` ajena no se reemplaza nunca (hay una sola por archivo): la barra queda vacía.
- Junto con esto, la franja del header llega al borde de arriba de la pantalla (y a los lados):
  los 8 px de padding de arriba ahora son parte del header.

**Descartadas.**
- *Leerlo de la salida del chat de la isla* (el `claude` del chat emite eventos de rate limit):
  no toca nada, pero solo se actualiza cuando se chatea desde la isla; casi siempre estaría viejo.
- *Preguntarle a la API de uso con el token de la suscripción*: prohibido por la regla 6.

**Consecuencias.** Las instalaciones de antes se ven como **Update…** en Settings, porque les
falta la `statusLine`. Si una versión futura de Claude Code deja de pasar `rate_limits` a la
status line, la barra se queda oculta sin que nada falle. Con la isla oculta no se gasta CPU: un
solo timer al reinicio de la ventana redibuja la barra.
