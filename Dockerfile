FROM node:22-alpine

ENV NODE_NO_WARNINGS=1
WORKDIR /app
# Same layout as the upstream image: config.yml is read from /app (cwd),
# the version from /app/app/package.json.
COPY app/package.json ./app/package.json
COPY app/dist/texecom2mqtt.js ./app/dist/texecom2mqtt.js

# The app logs out of the panel cleanly on SIGINT.
STOPSIGNAL SIGINT
CMD ["node", "./app/dist/texecom2mqtt.js"]
