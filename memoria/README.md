# memoria/ — Memoria versionada del proyecto

**Principio:** toda la memoria vive acá, en el repo, no en la memoria local de ninguna
herramienta. Cualquier sesión futura levanta el contexto completo leyendo esto.

| Archivo | Cuándo se escribe |
|---|---|
| `decisiones.md` | Cada vez que se decide algo estructural, **o se descarta una opción** |
| `preguntas-abiertas.md` | Cada vez que aparece algo que no sabemos y condiciona una decisión |
| `bitacora/` | Una entrada por sesión de trabajo: `AAAA-MM-DD-titulo.md` |

## Reglas

1. Las decisiones **descartadas se registran igual**, con su razonamiento. Evita re-litigar
   lo mismo en tres meses.
2. Una decisión no se borra ni se reescribe: si cambia, se marca `superada por D-NNN` y se
   agrega una nueva.
3. Las preguntas resueltas **no se borran**: se mueven a "Resueltas" con fecha y dónde quedó
   la respuesta.
4. Si algo no se puede verificar, va a `preguntas-abiertas.md`. Nunca se inventa.
5. La bitácora es narrativa y corta: qué pasó y a dónde linkea. El detalle técnico vive en
   `windows/README.md`, `windows/TESTING.md` y en `decisiones.md`.
