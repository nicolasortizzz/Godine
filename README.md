# Godine - Encuesta semanal con login

Aplicación web en Node.js + Express + NeDB (persistencia en archivos JSON) para:

- Login de usuarios.
- Activación semanal de encuesta por administrador (solo en sábado).
- Encuesta de 7 preguntas con selección obligatoria de una opción válida entre los nombres configurados.
- No se puede repetir nombre dentro de las 7 elecciones de la misma encuesta.
- Restricción de una respuesta por usuario por semana.
- Almacenamiento persistente en base de datos.
- Exportación del historial a CSV desde el panel.
- Contraseñas iniciales generadas aleatoriamente.

## Requisitos

- Node.js 18 o superior.

## Instalación

```bash
npm install
npm start
```

La app se levanta en `http://localhost:3000`.

## Deploy en web (Render)

Este proyecto incluye `render.yaml` para deploy rápido.

Pasos:

1. Subir este proyecto a un repositorio de GitHub.
2. Entrar a Render y elegir New + Blueprint.
3. Seleccionar el repositorio.
4. Confirmar el deploy.

Notas:

- Se crea un disco persistente montado en `/data`.
- La app guarda base y credenciales generadas en `DATA_DIR`.
- El archivo de claves iniciales se guarda como `generated_credentials.txt` en el disco persistente.

## Credenciales iniciales aleatorias

Al iniciar por primera vez (o al migrar usuarios antiguos), las claves se generan de forma aleatoria.

Revisa el archivo:

- `generated_credentials.txt`

Allí encontrarás usuario y clave temporal para cada cuenta base.

## Flujo

1. Iniciar sesión.
2. El administrador entra a `/admin` y activa la encuesta el sábado.
3. Los usuarios responden una sola vez durante esa semana.
4. Las respuestas quedan guardadas en archivos de base de datos (`db_*.json`).
5. Desde el panel se puede descargar el historial en CSV.

## Estructura

- `src/server.js`: rutas y reglas de negocio HTTP.
- `src/db.js`: colecciones de base de datos y operaciones de persistencia.
- `src/constants.js`: cantidad de preguntas y lista de nombres válidos.
- `views/`: vistas EJS.
- `public/style.css`: estilos.
- `render.yaml`: configuración de deploy para Render.

## Nota de producción

Antes de usar en producción:

- Cambiar `SESSION_SECRET` por una clave fuerte.
- Cambiar credenciales iniciales.
- Usar HTTPS y cookies seguras.
