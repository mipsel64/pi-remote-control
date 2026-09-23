FROM node:25-bookworm-slim AS web
WORKDIR /web
COPY server/web/package.json server/web/package-lock.json ./
RUN npm ci
COPY server/web/ ./
RUN npm run build

FROM rust:1.98-bookworm AS build
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock server/build.rs ./
COPY server/src ./src
COPY --from=web /web/dist ./web/dist
ARG GIT_SHA=unknown
ARG BUILD_DATE
RUN cargo build --locked --release \
    && install -d -m 0700 /var/lib/prc

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/target/release/prc /usr/local/bin/prc
COPY --from=build --chown=65532:65532 /var/lib/prc /var/lib/prc
COPY LICENSE /usr/share/licenses/prc/LICENSE
ENV HOME=/home/nonroot XDG_STATE_HOME=/var/lib RC_HOST=0.0.0.0
USER 65532:65532
RUN ["/usr/local/bin/prc", "--version"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/prc"]
CMD ["serve"]
