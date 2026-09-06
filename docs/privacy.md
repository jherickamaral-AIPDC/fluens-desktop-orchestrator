# Privacidad y selección pública

La copia pública se prepara con una lista positiva de fuentes. No se sube una carpeta completa esperando que `.gitignore` elimine todo lo privado.

## Incluido

Código de interfaz y runtime, pruebas sintéticas, el esqueleto experimental y documentación nueva para lectores. Las instrucciones de inicio y los pins de assets se adaptaron a esta copia.

## Excluido

Configuraciones reales, cuentas, credenciales, sesiones, perfiles de navegador, exportaciones de chats, notas personales, mapas de conocimiento internos, prompts de coordinación, aprobaciones, recibos, capturas, binarios, logs y manifiestos de instalaciones privadas.

Los generadores y los inventarios de procedencia original→copia se conservan fuera del repositorio público. No se publica el historial local de desarrollo.

## Controles

- Pertenencia a la única raíz autorizada, sin seguir enlaces.
- Revisión de los bytes seleccionados y clasificación de coincidencias parecidas a credenciales.
- Manifiesto de hashes de la copia final y cotejo con el árbol remoto.
- Historial nuevo con correo anónimo de GitHub, sin importar commits anteriores.
- Configuración de ejemplo inerte y exclusiones preventivas para trabajo futuro.

Estos controles reducen riesgo, pero no justifican una garantía universal de ausencia de datos no reconocidos. `.gitignore` no elimina archivos ya incluidos en un commit ni limpia su historial: hay que revisar el contenido y los metadatos antes de compartir.

## Uso local

Usa texto sintético para probar. No pegues contraseñas, tokens, información de cuentas ni conversaciones privadas. El almacenamiento del navegador pertenece al usuario y debe mantenerse fuera de cualquier exportación pública.

Para señalar un problema, no publiques datos personales ni valores secretos. Comparte solo una descripción técnica mínima por un canal privado acordado con el propietario; este repositorio no anuncia un canal de reporte adicional.
