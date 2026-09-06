# Fluens Desktop Orchestrator

**Un espacio local para organizar agentes, conversaciones y contexto, con un runtime de integración explícita.**

Local-first workspace for agents, conversations and bounded provider adapters. This repository is an experimental source release, not a hosted AI service.

`Estado: experimental` · `Node.js 24+` · `Sin dependencias npm` · `Preview sin proveedores`

## Qué puedes explorar

- **Interfaz de escritorio web:** agentes, chats, contexto y almacenamiento del navegador.
- **Runtime local:** enrutamiento determinista, flujo incremental, cancelación y aislamiento de sesiones.
- **Adaptadores de motor:** código de integración y transports inyectables para pruebas.
- **Referencia experimental:** un esqueleto de adaptador cTrader, separado y no operativo.

La publicación contiene fuentes seleccionadas y revisadas. No incluye cuentas, configuraciones personales, conversaciones, credenciales, aprobaciones operativas ni el historial interno del proyecto.

## Inicio rápido

Requiere Node.js 24 o superior. Abre una terminal en la carpeta de este repositorio:

```sh
npm run check
npm test
npm run preview
```

No hace falta `npm install`: no hay paquetes externos. Abre **http://127.0.0.1:8787** mientras el preview esté activo. Para detenerlo, usa `Ctrl+C`.

El preview usa exclusivamente esta copia del código y escucha en loopback. No lee configuraciones privadas, no abre aplicaciones de proveedor, no inicia sesión y no abre automáticamente el navegador. Ambos proveedores permanecen deshabilitados: **puedes explorar la interfaz, pero no obtener respuestas de IA**. Un intento de envío termina con `PROVIDER_DISABLED`.

Usa un perfil de navegador vacío y texto sintético. Los datos que escribas en la interfaz se guardan localmente en ese navegador; no son parte del repositorio. No abras `index.html` con doble clic: necesita un origen HTTP local estable.

## Estructura

```text
apps/ui/                 Interfaz HTML, CSS y JavaScript
packages/runtime/src/    Configuración, driver y entrada del runtime
packages/runtime/vendor/ Motor y puente incluidos en las fuentes
packages/runtime/test/   Pruebas con transports en memoria
experimental/ctrader/    Esqueleto de referencia, sin integración activa
tools/                   Preview y verificadores públicos
docs/                    Arquitectura, privacidad y pruebas
PUBLIC_SOURCE_MANIFEST.json
```

## Lectura recomendada

1. [Arquitectura y límites](docs/architecture.md)
2. [Pruebas y alcance de la evidencia](docs/testing.md)
3. [Privacidad y selección pública](docs/privacy.md)
4. [Contribución y mantenimiento](CONTRIBUTING.md)
5. [Referencia cTrader](experimental/ctrader/README.md)

## Estado real

| Componente | Incluido | Límite actual |
| --- | --- | --- |
| Interfaz local | Sí | Datos del navegador, no sincronización en nube |
| Preview | Sí | Proveedores siempre deshabilitados |
| Runtime y adaptadores | Sí | Su presencia no habilita uso real ni concede permisos |
| Pruebas sintéticas | Sí | No certifican compatibilidad de servicios reales |
| cTrader | Solo referencia | Faltan dependencias; no es autónomo ni operativo |
| Configuración y evidencia privada | No | Deliberadamente fuera de la publicación |

Esta entrega no declara terminado el producto, no sustituye revisiones privadas anteriores y no habilita trading ni automatización de cuentas. No se ofrece una garantía absoluta de ausencia de defectos.

## Integridad y acceso

```sh
npm run verify
```

Comprueba que los archivos coincidan con el manifiesto público. Los hashes detectan cambios; no demuestran por sí solos que un archivo sea confiable o que pueda compartirse.

El repositorio se ofrece para consulta pública. No se añade una licencia nueva en esta entrega; consulta [NOTICE.md](NOTICE.md). Los visitantes no reciben permisos de escritura sobre el repositorio del propietario.
