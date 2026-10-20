# Agenda Barber — Reservas para barbería

Aplicación web para que los clientes reserven su cita en línea y el equipo de la barbería pueda consultar la agenda desde un panel privado. La experiencia está en español y el diseño se adapta a celular y escritorio.

## Qué resuelve

- Presenta servicios, precios y duración.
- Permite elegir servicio, barbero, fecha y espacio disponible.
- Guarda cada reserva y muestra una confirmación inmediata.
- Comprueba nuevamente el espacio antes de guardar la cita, para rechazar una reserva duplicada.
- Prepara un mensaje a la barbería por WhatsApp con la cita ya escrita; el cliente lo envía con un toque.
- Incluye un panel protegido por código con calendario de un día, filtros por barbero y estados de cita.
- Actualiza el panel cada 20 segundos y puede mostrar avisos del navegador cuando llega una cita nueva, si el panel está abierto y el barbero activa los avisos.
- Permite ajustar desde el panel las horas de apertura y cierre, los días de cierre general y los días de descanso de cada barbero.
- Permite editar los precios y guardar el teléfono de WhatsApp de cada barbero.
- Con WhatsApp Cloud API configurado, encola la confirmación al reservar, el recordatorio 90 minutos antes y avisos de cambio de estado al cliente y al barbero asignado.
- Guarda los datos localmente en un archivo JSON, sin exigir una cuenta de base de datos para empezar.

## Requisitos

- Node.js 20.6 o superior.
- No requiere instalar paquetes adicionales.

## Iniciar en tu computador

1. Descarga o clona el proyecto.
2. Copia `.env.example` como `.env` y ajusta el código de acceso y el número de WhatsApp.
3. En una terminal, dentro de la carpeta del proyecto, ejecuta `npm start`.
4. Abre `http://localhost:3000`.
5. Para abrir el panel, pulsa **Acceso barbería**. El código inicial del ejemplo es `2468`; cámbialo antes de compartir la aplicación.

También puedes ejecutar `node server.js` directamente; en ese caso el servidor usa valores de demostración y el código de acceso inicial es `2468`.

## Configuración

El comando `npm start` carga el archivo `.env` usando Node.js. Si lo ejecutas directamente, Node.js 20.6 o superior también permite iniciar con `node --env-file=.env server.js`.

| Variable | Uso | Ejemplo |
| --- | --- | --- |
| `PORT` | Puerto del sitio | `3000` |
| `BUSINESS_NAME` | Nombre mostrado en la página | `Corte & Estilo` |
| `ADMIN_PIN` | Código de acceso al panel | Un código propio |
| `SESSION_SECRET` | Clave que protege la sesión del panel | Texto aleatorio de 32 caracteres o más |
| `WHATSAPP_NUMBER` | Número internacional sin `+` ni espacios | `573001234567` |
| `WA_PHONE_NUMBER_ID` | ID del número emisor registrado en WhatsApp Cloud API | ID entregado por Meta |
| `WA_ACCESS_TOKEN` | Token privado de la API; nunca se publica en el navegador | Token del usuario del sistema |
| `WA_GRAPH_API_VERSION` | Versión de Graph API activa en la app de Meta | Por ejemplo, la versión indicada en tu app |
| `WA_TEMPLATE_LANGUAGE` | Idioma de las plantillas aprobadas | `es_CO` |
| `WA_TEMPLATE_BOOKED` | Plantilla para nueva cita | `cita_agendada` |
| `WA_TEMPLATE_REMINDER` | Plantilla para el recordatorio | `recordatorio_cita` |
| `WA_TEMPLATE_STATUS` | Plantilla para cambio de estado del cliente | `estado_cita` |
| `WA_TEMPLATE_BARBER` | Plantilla para aviso al barbero | `aviso_barbero` |
| `BUSINESS_TIMEZONE` | Zona horaria de la barbería | `America/Bogota` |
| `OPEN_HOUR` | Hora inicial de atención | `9` |
| `CLOSE_HOUR` | Hora final de atención | `19` |

Los servicios y barberos de ejemplo se definen al inicio de `server.js`. Los horarios, descansos, teléfonos de barberos y autorización para recibir avisos internos se editan desde el panel. Los precios se editan en **Editar precios de los servicios**. Los cambios de precio aplican a nuevas reservas; una cita existente conserva el precio con que se reservó. Las reservas, precios y ajustes se guardan en `data/appointments.json`; ese archivo no se sube al repositorio porque contiene datos personales.

## WhatsApp y automatización

La conexión oficial usa el número de la barbería como emisor (`WA_PHONE_NUMBER_ID`) y los teléfonos personales de los barberos como destinatarios de avisos internos. Para activar envíos, configura las credenciales privadas en `.env`, los nombres de plantilla y la versión de Graph API. El token solo se usa en el servidor; nunca se envía al navegador. No pegues secretos en el repositorio ni en el chat.

Meta debe tener aprobadas las cuatro plantillas configuradas. Sus variables, en orden, son:

- `cita_agendada`: nombre del cliente, barbería, fecha, hora, servicio y barbero.
- `recordatorio_cita`: nombre del cliente, barbería, fecha, hora, servicio y barbero.
- `estado_cita`: nombre del cliente, barbería, estado, fecha, hora, servicio y barbero.
- `aviso_barbero`: nombre del barbero, cliente, teléfono del cliente, servicio, fecha, hora y estado.

Textos de referencia para crear las plantillas en español:

- `cita_agendada`: `Hola {{1}}, tu cita en {{2}} está confirmada para el {{3}} a las {{4}}. Servicio: {{5}} con {{6}}.`
- `recordatorio_cita`: `Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}. Servicio: {{5}} con {{6}}.`
- `estado_cita`: `Hola {{1}}, el estado de tu cita en {{2}} es {{3}}. Fecha: {{4}}, hora: {{5}}, servicio: {{6}}, barbero: {{7}}.`
- `aviso_barbero`: `Hola {{1}}, {{2}} reservó {{4}} para el {{5}} a las {{6}}. Cliente: {{3}}. Estado: {{7}}.`

Configura cada plantilla como mensaje transaccional en el administrador de WhatsApp, con idioma `es_CO`, y espera la aprobación antes de probar el envío.

El cliente marca una casilla para autorizar los mensajes relacionados con su cita. Cada barbero también debe tener su número y autorización guardados en el panel. Después de guardar esos datos, pulsa **Probar mensaje** junto al barbero para validar la conexión; Meta aceptará el mensaje solo si las credenciales, el número y la plantilla son válidos. La agenda muestra si cada aviso está en cola, programado, aceptado por Meta o falló. “Aceptado” no confirma la entrega al teléfono; para consultar entrega y lectura habría que añadir webhooks.

El servidor revisa la cola de WhatsApp cada 15 segundos y reintenta errores temporales hasta cuatro veces. Debe estar ejecutándose de manera continua para enviar el recordatorio a tiempo; en despliegue, el servidor necesita HTTPS y almacenamiento persistente. Si no configuras la API, el sitio conserva el enlace manual de WhatsApp.

Para mensajes iniciados por el negocio, WhatsApp exige mensajes plantilla aprobados y permiso de la persona que los recibe. Revisa la [política de mensajería de WhatsApp Business](https://business.whatsapp.com/policy/preview?lang=es_LA) y la [colección oficial de Cloud API de Meta](https://www.postman.com/meta/whatsapp-business-platform/overview). La API y la aplicación WhatsApp Business pueden requerir un alta específica; verifica si tu número puede usar coexistencia antes de conectarlo para no interrumpir el uso actual.

## Publicación en internet

Para un despliegue real, usa un servicio que ejecute Node.js y ofrezca almacenamiento persistente para `data/appointments.json`, configura secretos propios y `NODE_ENV=production`, habilita HTTPS y haz copias de respaldo. La protección de intentos de acceso se aplica por proceso, y el archivo JSON está pensado para una barbería pequeña en una sola instancia. Si necesitas varias instancias o más volumen, conviene migrar las citas a PostgreSQL o MongoDB.

## Estructura

```text
.
├── data/                  # Se crea al iniciar; datos locales ignorados por Git
├── public/
│   ├── app.js              # Flujo de reserva y panel de gestión
│   ├── favicon.svg
│   ├── index.html
│   └── styles.css
├── .env.example
├── .gitignore
├── package.json
└── server.js               # API, disponibilidad, persistencia y sesión del panel
```

## Ideas para una segunda versión

- Base de datos administrada y respaldos automáticos.
- Registro de pagos y reportes mensuales.
- Confirmaciones y cancelaciones desde un enlace personal del cliente.
