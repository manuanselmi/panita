# 2026-09-30 / 2026-10-01 — De instalar Coucou a tener panita

Sesión larga, abierta desde `C:\Users\manua\Documents\GitHub` (no desde el repo). Arrancó como
"quiero instalarme esto" y terminó con un fork propio en uso diario.

## Qué se hizo

1. **Instalación desde fuente.** Se clonó `Louis-CFM/coucou` y se revisó el código antes de
   compilar: relay, pipe y red solo hacia servicios configurados. Se instalaron Rust y VS Build
   Tools 2022 y se compiló el instalador de Windows. Se instalaron los hooks de Claude Code
   desde Settings.
2. **Fork privado** `manuanselmi/panita` con historial y `upstream` (D-002). Actions desactivado.
3. **Banco de pruebas** (subagente): instancia lateral `COUCOU_INSTANCE`, unit + e2e por CDP,
   `windows/TESTING.md` (D-003). Se le corrigió un bug que solo aparecía en PowerShell.
4. **Ticker**: los pasos se pisaban. Se agregó un test de regresión que falla sin el arreglo, y
   las etiquetas pasaron a español.
5. **En paralelo, con subagentes y worktrees**: una tarjeta por sesión (D-004, D-005); hooks en
   WSL y "Open" que enfoca la ventana existente (D-008, D-009). Integración en `integration`,
   merge de Manuel, reinstalación y prueba supervisada: anda, incluido el cambio de escritorio
   virtual.
6. **Segunda tanda**: extensión companion para enfocar la pestaña exacta (D-010); tarjeta
   derecha solo con panitas y numeración de nombres repetidos (D-006); explicación de comandos
   en la tarjeta de permiso (D-011). Integración en `integration2`: 104 tests de Rust, 445 de TS
   y 56 e2e en verde. Merge de Manuel (`c4c6583`), reinstalación, `Update…` de los hooks WSL y
   extensión instalada por CLI. La pestaña exacta quedó confirmada en el log, en Windows y en WSL.
7. Este `CLAUDE.md` y `memoria/` (D-001).

## Qué se aprendió

- **Un proceso lanzado desde una consola parada en el repo bloquea la carpeta.** Coucou heredó
  `coucou\windows` como directorio de trabajo y no se la pudo renombrar. Por eso se clonó
  `panita` en una carpeta nueva.
- **El modo auto bloquea, con razón**, matar la app instalada y mergear a `main` sin revisión:
  de ahí la instancia lateral (D-003) y el flujo de merges (D-014).
- **Un test verde no prueba nada si no se lo vio fallar.** El primer test del ticker pasaba con
  el bug presente: el solapamiento solo aparece con pasos más anchos que la fila, y el test
  usaba textos cortos.
- **`WSLENV`**: con `/u`, una variable seteada en Linux no llega al proceso de Windows. El brief
  lo tenía al revés y el subagente lo detectó antes de mandarle eventos a la app real.
- **Dos e2e en paralelo con el mismo nombre de instancia se pisan.** De ahí `COUCOU_E2E_INSTANCE`.
- `Terminal.processId` en Remote-WSL es el PID Linux de la shell. VS Code activó la extensión
  recién instalada sin recargar ventanas.
- Las sesiones repetidas de `struxto-especificador` no eran subagentes: eran tres sesiones
  reales en el mismo proyecto (se vio en los transcripts de WSL).

## Qué se decidió

D-001 a D-014 en `memoria/decisiones.md`. Las que más condicionan lo que sigue: la instancia
lateral es firme (D-003); el orden por actividad lo eligió Manuel contra la recomendación de
fijar las tarjetas (D-004); D-006 superó el layout de D-005; los merges los hace Manuel (D-014).

## Qué queda pendiente

- Ver `memoria/preguntas-abiertas.md`. Lo más próximo:
  - limpieza de worktrees, ramas y la carpeta vieja `coucou` (O2);
  - probar el botón Install de la extensión con un click real (O1);
  - estrategia para traer cambios del upstream (I1).
- Seguir ampliando el diccionario de comandos (`windows/src/core/explain.ts`) a medida que
  aparezcan comandos sin explicación.
- Las próximas sesiones se abren desde `C:\Users\manua\Documents\GitHub\panita`.
