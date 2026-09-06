# Pruebas reproducibles

Desde la raíz, con Node.js 24+:

```sh
npm run check
npm test
npm run verify
```

No se instalan dependencias ni se contactan proveedores. La suite usa transports en memoria, temporales propios y loopback para comprobar el preview. No lee la configuración real de una instalación.

| Grupo | Qué comprueba |
| --- | --- |
| runtime.test.mjs | Enrutamiento, prompt, sesiones, cancelación y rechazo del resultado |
| safety.test.mjs | Límites del transporte, timeout, drain, allowlist de entorno y errores acotados |
| preview.test.mjs | Configuración inerte, inventario local, respuesta HTTP y rechazo de proveedores |
| check.mjs | Sintaxis JavaScript y JSON válidos |
| verify-manifest.mjs | Igualdad de archivos, tamaños y SHA-256 con el manifiesto |

Se omitieron suites históricas que dependen de aprobaciones, ledgers, preimágenes o instalaciones privadas. Sus resultados no se trasladan a esta copia. Tampoco se atribuyen resultados de C# sin las dependencias externas requeridas por aquel esqueleto.

Los fallos de infraestructura se distinguen de errores de sintaxis: si Node no puede iniciar la comprobación, el verificador falla con `NODE_CHECK_UNAVAILABLE`.

Modificar un archivo invalida el manifiesto hasta una nueva revisión y generación explícita. No regeneres hashes para ocultar diferencias ni interpretes un manifiesto nuevo como aprobación de un cambio.
