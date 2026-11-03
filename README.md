# IkaDios

Extensión de navegador para [Ikariam](https://es.ikariam.gameforge.com/). Añade al juego un panel con el resumen de toda la cuenta (ciudades, recursos, tropas, flotas, batallas, espionaje, comercio), un mapa del mundo, avisos en el escritorio y en Discord, automatizaciones de construcción y transporte, y packs de imágenes para los cuatro consejeros.

Funciona en **Chrome**, **Brave** y **Firefox 128 o superior**. Está en español e inglés.

## Instalación

No hace falta compilar nada ni instalar dependencias: la extensión se carga tal cual desde la carpeta.

### 1. Descargar el código

Con git:

```
git clone https://github.com/trucdefou/ikadios.git
```

O sin git: en la página del repositorio, **Code > Download ZIP**, y descomprime el archivo en una carpeta que no vayas a borrar. El navegador carga la extensión desde esa carpeta cada vez que arranca.

### 2a. Chrome o Brave

1. Abre `chrome://extensions` (en Brave, `brave://extensions`).
2. Activa el **Modo de desarrollador** (interruptor arriba a la derecha).
3. Pulsa **Cargar descomprimida** y elige la carpeta `ikadios` (la que contiene `manifest.json`).
4. Opcional: fija la extensión en la barra con el icono del puzzle para tener el popup a mano.

Chrome puede mostrar un aviso sobre extensiones en modo de desarrollador al arrancar; es normal en extensiones que no vienen de la Chrome Web Store.

### 2b. Firefox

1. Abre `about:debugging#/runtime/this-firefox`.
2. Pulsa **Cargar complemento temporal...** y elige el archivo `manifest.json` de la carpeta `ikadios`.
3. Si Firefox pide permisos para los sitios de Ikariam, Discord e ika-map, acéptalos: sin ellos no funcionan el refresco en segundo plano, el mapa ni Discord.

Firefox quita los complementos temporales al cerrarse, así que hay que repetir el paso 2 cada vez que lo abras. Tus datos se conservan.

### 3. Comprobar que funciona

1. Abre o recarga una pestaña del juego y entra en tu mundo.
2. Abajo a la derecha aparece el emblema de IkaDios. Púlsalo, o usa **Alt+B**, para abrir el panel.
3. Recorre algunas vistas del juego (ciudades, asesores, puerto) o pulsa **Actualizar todo** en el panel: IkaDios va rellenando los datos a medida que el juego los carga.

## Configuración

Las opciones están en el popup de la extensión o en **Detalles > Opciones de extensión**:

- **Idioma**: por defecto el del servidor del juego.
- **Discord**: añade uno o varios webhooks de tu servidor para recibir avisos de ataques, resúmenes y compartir informes.
- **Bot de alianza**: token de un bot de Discord y el ID de un canal privado, para compartir informes y coordinar con tu alianza (ver [Bot de alianza](#bot-de-alianza-discord)).
- **Consejeros**: elige, edita, importa o exporta packs de imágenes.
- **Avisos**: umbrales de vino, almacén, oro, felicidad, etc.

Los webhooks, el token del bot y todos tus datos del juego se guardan solo en tu navegador. No viajan con el código ni se envían a ningún servidor de IkaDios, que no existe. Lo único que sale del navegador es lo que tú mandas a Discord y la consulta del mapa del mundo a la API pública de ika-map.com.

## Bot de alianza (Discord)

Opcional. Con un bot de Discord, todos los miembros de la alianza que usen IkaDios comparten en un canal privado informes de batalla y de espionaje, notas sobre jugadores, planes de ataque, pedidos de recursos y su estado (barcos libres, tropas, ataques entrantes). Cada IkaDios lee el canal cada pocos minutos e importa lo que publican los demás.

El bot lo crea una sola persona de la alianza; los demás solo necesitan el token y el ID del canal.

### 1. Crear el bot

1. Entra en <https://discord.com/developers/applications> y pulsa **New Application**. Ponle un nombre, por ejemplo "IkaDios Alianza".
2. Pestaña **Installation**: en **Install Link** elige **None** y guarda. Si no, Discord no deja hacer privado el bot.
3. Pestaña **Bot**:
   - **Reset Token** y copia el token. Discord solo lo muestra una vez; si lo pierdes, genera otro.
   - Activa **Message Content Intent**. Sin esto el bot ve vacíos los mensajes de los demás y no importa nada.
   - Desactiva **Public Bot** (opcional), para que nadie más pueda añadirlo a otros servidores.
4. Pestaña **OAuth2 > URL Generator**:
   - Scope: `bot`.
   - Permisos: **View Channels**, **Send Messages**, **Embed Links**, **Attach Files** y **Read Message History**.
   - Abre la URL generada, elige el servidor de la alianza y autoriza (necesitas permiso para administrar el servidor).

### 2. Preparar el canal

1. Crea un canal de texto **privado** (por ejemplo `#ikadios`) que solo vean los miembros de la alianza.
2. En los permisos del canal, añade el bot con los mismos permisos del paso anterior.
3. Copia el ID del canal: activa *Ajustes de usuario > Avanzado > Modo desarrollador*, luego clic derecho en el canal y **Copiar ID del canal**.

### 3. Configurarlo en IkaDios (cada miembro)

1. Opciones de la extensión, sección **Bot de alianza**.
2. Pega el **Token del bot** y el **ID del canal**, y marca **Usar el bot de alianza**.
3. Pulsa **Probar conexión**. Debe decir "Conectado al canal #ikadios".
4. Elige qué publicar automáticamente (informes de espionaje nuevos, planes de ataque, notas, estado) y cada cuántos minutos leer el canal.

### Errores de "Probar conexión"

| Mensaje | Causa | Solución |
| --- | --- | --- |
| Discord rechazó el token (401) | Token mal copiado, o es el de la aplicación y no el del bot | Copia el token de la pestaña **Bot** (o genera uno nuevo con **Reset Token**) |
| El bot no ve ese canal (403) | El bot no está en el servidor o no puede ver el canal | Invítalo con la URL de **OAuth2** y dale **Ver canal** y **Leer el historial de mensajes** en el canal |
| El bot ve el canal pero le faltan permisos (403) | Puede leer pero no escribir | Dale **Enviar mensajes**, **Insertar enlaces** y **Adjuntar archivos** en el canal |
| Discord bloqueó la petición (403, código 40333) | Discord rechaza peticiones de bots que parecen venir de un navegador | Actualiza IkaDios y recárgala en la página de extensiones; si sigue, prueba sin VPN ni proxy |
| No existe ese canal o el ID no es válido | El ID es del servidor o de un mensaje, no del canal | Copia el ID con clic derecho sobre el canal |
| Conecta pero no importa nada | Falta el **Message Content Intent** | Actívalo en la pestaña **Bot** |

### Seguridad del token

Todos los miembros usan el mismo token. Quien lo tenga puede leer y escribir en el canal como el bot, así que pásalo solo por privado a gente de confianza. El token se guarda en el navegador de cada uno y solo se envía a Discord. Si se filtra, pulsa **Reset Token** en el portal y reparte el nuevo: el anterior deja de funcionar al momento.

## Actualizar

1. Descarga la versión nueva (`git pull` en la carpeta, o vuelve a bajar el ZIP y reemplaza los archivos).
2. Chrome o Brave: en `chrome://extensions`, pulsa el botón de recargar de la tarjeta de IkaDios. Firefox: en `about:debugging`, **Recargar**.
3. Recarga la pestaña del juego.

No borres la extensión para actualizarla: al quitarla se borran sus datos guardados (cuentas, packs, ajustes, webhooks).

## Problemas frecuentes

- **No aparece el emblema**: recarga la pestaña del juego después de instalar o actualizar la extensión.
- **"Actualizar todo" falla con sesión caducada**: entra de nuevo en el juego en una pestaña y vuelve a intentarlo.
- **Faltan datos en una pestaña del panel**: abre esa vista en el juego una vez o pulsa **Actualizar pestaña** en la barra del panel.
