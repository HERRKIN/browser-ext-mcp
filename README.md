# browser-ext-mcp

Extensión de Chrome + bridge MCP para que un agente controle tu navegador real, no una instancia aislada tipo Playwright/headless.

La meta es acercarnos lo más posible al comportamiento de productos como Claude in Chrome, pero con foco en:

- usar tu sesión real de Chrome, con cookies, extensiones, logins y 2FA ya presentes
- permitir tareas útiles de verdad: rellenar formularios, navegar flujos repetitivos, sacar screenshots, analizar estructura de páginas, revisar responsive design, leer consola/red/DOM y automatizar trabajo aburrido
- mantener guardrails fuertes: permisos por sitio, confirmaciones para acciones sensibles, trazabilidad y controles contra prompt injection

## Qué queremos construir

Un sistema con dos piezas principales:

1. Una extensión Chrome Manifest V3 con side panel persistente.
2. Un bridge local que exponga herramientas MCP para que Codex u otro cliente pueda operar el navegador del usuario.

La decisión central de producto es explícita:

> no queremos un "MCP para Playwright" que lance otro navegador; queremos control del Chrome real del usuario.

## Benchmark investigado

### 1. Claude in Chrome

Lo más relevante que hoy publica Anthropic:

- El Chrome Web Store describe a Claude in Chrome como una extensión que navega sitios, llena formularios, extrae datos, corre workflows multi-step, scheduled tasks, multi-tab workflows y lectura de console/network/DOM state desde el navegador.
- El artículo de onboarding de Claude in Chrome explica que usa `sidePanel`, `storage`, `scripting`, `debugger`, `tabGroups` y `tabs`, y que `debugger` es el permiso que habilita clicks, typing y screenshots.
- La guía de permisos confirma un modelo de control por plan/aprobación: `Ask before acting`, `Act without asking`, permisos por sitio, allowlists/blocklists y acciones explícitamente protegidas.
- El post “Piloting Claude in Chrome” deja claro que el problema central no es solo automatizar, sino automatizar con defensas reales contra prompt injection.

### 2. APIs oficiales de Chrome que sí nos sirven

Las piezas clave oficiales son:

- `chrome.sidePanel` para UI persistente al lado de la pestaña.
- `chrome.scripting.executeScript()` para inyectar lectura/acciones en páginas y frames.
- `chrome.debugger` como transporte CDP para `Input`, `Page`, `Network`, `DOM`, `Log`, `Performance`, `Emulation`, etc.
- `chrome.tabs.captureVisibleTab()` como captura rápida de viewport cuando no necesitemos CDP completo.
- `nativeMessaging` como opción futura para integración desktop, no como punto de arranque.
- `optional_host_permissions` y `activeTab` para reducir permisos amplios en v1.

### 3. OSS comparable

Los proyectos comparables más útiles encontrados:

- [`ChromeDevTools/chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp): referencia fuerte para debugging, screenshots, network, performance y emulation vía DevTools.
- [`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome): referencia de extensión + bridge MCP sobre el navegador real.
- [`remorses/playwriter`](https://github.com/remorses/playwriter): referencia útil por usar el navegador real del usuario y evitar relanzar Chrome, aunque su superficie está centrada en Playwright snippets.
- [`Browser MCP by Agent360`](https://browsermcp.dev/): referencia de producto para sesiones concurrentes, CAPTCHA y human-in-the-loop.

## Tesis de arquitectura

### V1

Objetivo: control útil y confiable sobre una sola pestaña del Chrome real.

Componentes:

- extensión MV3
- side panel
- service worker
- content scripts
- bridge MCP local por WebSocket/HTTP local

Capacidades mínimas:

- `tabs_list`
- `tab_focus`
- `navigate`
- `read_page`
- `find_elements`
- `click`
- `type`
- `form_fill`
- `screenshot_viewport`
- `console_logs`
- `network_log_start` / `network_log_stop`

Principio: primero herramientas pequeñas, deterministas y auditables; no un tool genérico que ejecute JavaScript arbitrario del agente desde el día uno.

### V2

Objetivo: análisis y debugging reales.

Agregar:

- `chrome.debugger` para CDP
- screenshots por `Page.captureScreenshot`
- emulación de viewport/dispositivo con `Emulation.setDeviceMetricsOverride`
- árbol accesible con referencias persistentes para reusar en click/fill/scroll
- soporte multi-tab básico
- snapshots DOM + red + consola en una misma corrida

### V3

Objetivo: experiencia “Claude in Chrome-like”.

Agregar:

- grabación/replay de workflows
- scheduling
- integración opcional con native host
- allowlists/blocklists administrables
- human handoff para login/CAPTCHA/2FA
- análisis comparativo de responsive design por múltiples breakpoints

## Diseño propuesto

### Extensión

`sidepanel/`

- chat UI
- permisos por sitio
- historial de acciones
- vista de plan/aprobación

`service-worker/`

- registro de tools
- lifecycle de pestañas
- puente con MCP local
- colas de acciones
- logs/auditoría
- `chrome.alarms` para automatizaciones futuras

`content-scripts/`

- lectura del DOM
- extracción de árbol accesible
- refs persistentes para elementos
- ejecución de acciones no-CDP
- highlighting/overlays

`debugger/`

- attach/detach a pestañas
- mouse/keyboard reales vía CDP
- screenshots, network, console, performance, emulation

### Bridge MCP local

Proceso local separado que:

- expone `tools/list` y `tools/call`
- mantiene sesión con la extensión
- serializa requests
- aplica timeouts/retries
- autentica el canal local
- persiste logs útiles

La recomendación actual es:

- v1: WebSocket o Streamable HTTP local
- v3: evaluar `nativeMessaging` solo si de verdad hace falta integración desktop estrecha

## Toolset que vale la pena copiar

### Lectura y análisis

- `read_page`
- `read_interactive_elements`
- `get_accessibility_tree`
- `get_clean_html`
- `get_layout_snapshot`
- `analyze_responsive_breakpoints`

### Interacción

- `navigate`
- `click`
- `hover`
- `scroll`
- `type`
- `press_keys`
- `select_option`
- `form_fill`
- `upload_file`

### Evidencia visual

- `screenshot_viewport`
- `screenshot_full_page`
- `screenshot_element`
- `screenshot_with_labels`

### Debugging

- `get_console_logs`
- `start_network_capture`
- `stop_network_capture`
- `get_last_requests`
- `get_performance_metrics`
- `emulate_viewport`

### Coordinación

- `tabs_list`
- `tab_switch`
- `tab_group_create`
- `tab_group_list`
- `wait_for`

## Cómo queremos resolver tareas concretas

### Rellenar formularios

No basta con hacer `element.value = "x"`.

Necesitamos:

- localizar por árbol accesible y fallback CSS/XPath interno
- disparar `input`, `change`, `blur` y otros eventos con bubbling
- soportar React/Vue/Angular y formularios con validación client-side
- usar CDP para typing/click real cuando la página lo requiera

### Analizar estructura de página

Debemos combinar tres vistas:

- árbol accesible
- DOM limpio/resumido
- evidencia visual con labels de elementos interactivos

Eso permite que el agente pueda:

- entender jerarquía
- ubicar CTAs y campos
- detectar layouts rotos
- tomar decisiones sin depender solo de OCR o solo de HTML crudo

### Analizar responsive design

La estrategia correcta no es una sola screenshot.

Queremos:

- correr la misma página en varios breakpoints
- guardar screenshot + layout snapshot + métricas por breakpoint
- detectar overflow horizontal, clipping, elementos ocultos, cambios de navegación, CTAs fuera del viewport y diferencias fuertes de densidad visual

Breakpoints sugeridos:

- móvil: `390x844`
- tablet: `768x1024`
- desktop: `1440x900`

### Screenshots

Dos modos:

- rápido: `tabs.captureVisibleTab`
- avanzado: `Page.captureScreenshot` con CDP, crop por región y full-page cuando convenga

### Debugging web real

Si queremos que el agente te ayude con bugs de UI, necesitamos:

- consola
- red
- DOM/CSS
- emulación

Sin eso, el agente solo “ve” la página; no la entiende como superficie de depuración.

## Seguridad y guardrails

Esto no es opcional. Si esta capa queda demasiado abierta, se vuelve peligrosa muy rápido.

### Reglas base

- modo por defecto: pedir aprobación antes de actuar
- permisos por sitio
- `optional_host_permissions` antes que acceso global permanente
- auditoría de cada tool call
- confirmación obligatoria para acciones irreversibles o sensibles

### Acciones que deben requerir confirmación explícita

- compras
- transacciones financieras
- creación de cuentas
- cambios de contraseña
- cambios de permisos o settings
- borrados permanentes
- envío de información sensible

### Acciones que no deberíamos automatizar en v1

- bypass de CAPTCHA
- bypass de 2FA
- operaciones financieras
- manejo de datos de tarjeta o identificación
- descargas desde orígenes no confiables
- ejecución abierta de scripts arbitrarios sin sandbox

## Decisiones importantes para el roadmap

### Lo que sí haremos primero

- navegador real del usuario
- side panel
- permisos por sitio
- lectura estructurada de página
- screenshots
- fill/click/type confiables
- logs de consola y red
- responsive analysis básica

### Lo que no haremos primero

- grabación compleja de workflows
- sincronización cloud
- soporte multi-browser serio
- engine genérico de reproducción tipo RPA enterprise
- “autonomía total” sin checkpoints
- dependencia de `--remote-debugging-port` como modo principal

## Stack propuesto

- TypeScript
- Chrome Extension Manifest V3
- React para side panel
- servicio local en Node.js para el bridge MCP
- `chrome.debugger` + `chrome.scripting` + `chrome.tabs`
- zod para contratos de tools
- logs estructurados JSONL

## Estructura inicial sugerida

```text
browser-ext-mcp/
├── README.md
├── .gitignore
├── extension/
│   ├── manifest.json
│   ├── sidepanel/
│   ├── service-worker/
│   ├── content-scripts/
│   └── debugger/
├── bridge/
│   ├── src/
│   └── package.json
└── docs/
    ├── architecture.md
    ├── tools.md
    ├── security.md
    └── roadmap.md
```

## Próximos pasos

1. Scaffold de la extensión MV3.
2. Scaffold del bridge MCP local.
3. Implementar herramientas mínimas: `navigate`, `read_page`, `click`, `type`, `form_fill`, `screenshot_viewport`.
4. Agregar permisos por sitio y approval flow.
5. Integrar `chrome.debugger` para consola/red/screenshots avanzados.
6. Construir `analyze_responsive_breakpoints`.

## Fuentes

### Oficiales

- Anthropic Chrome Web Store: [Claude in Chrome (Beta)](https://chromewebstore.google.com/publisher/anthropic/u308d63ea0533efcf7ba778ad42da7390)
- Anthropic Help Center: [Get started with Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
- Anthropic Help Center: [Claude in Chrome Permissions Guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)
- Anthropic blog: [Piloting Claude in Chrome](https://claude.com/blog/claude-for-chrome)
- Anthropic research: [Mitigating the risk of prompt injections in browser use](https://www.anthropic.com/research/prompt-injection-defenses)
- Chrome docs: [chrome.sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- Chrome docs: [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- Chrome docs: [chrome.tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- Chrome docs: [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- Chrome docs: [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- Chrome docs: [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- Chrome DevTools Protocol: [Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)
- Chrome DevTools Protocol: [Emulation.setDeviceMetricsOverride](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride)
- Google: [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)

### Comparables / inspiración

- [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome)
- [remorses/playwriter](https://github.com/remorses/playwriter)
- [Browser MCP by Agent360](https://browsermcp.dev/)

### Nota

También revisé un reverse-engineering no oficial de Claude in Chrome para inferir posibles decisiones internas. Lo uso solo como inspiración de diseño, no como fuente canónica:

- [Claude for Chrome Extension Internals (gist)](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)
