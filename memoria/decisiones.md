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

**Fecha:** 2026-09-30 · **Estado:** vigente

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
