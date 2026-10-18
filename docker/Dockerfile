# syntax=docker/dockerfile:1
ARG ODOO_VERSION=19.0

# Tahap 1: ambil modul OCA pada commit yang dikunci di oca.lock
FROM alpine:3.20 AS oca
RUN apk add --no-cache git
COPY oca.lock /work/oca.lock
COPY scripts/fetch-oca.sh /work/fetch-oca.sh
RUN sh /work/fetch-oca.sh /work/oca.lock /oca \
    && find /oca -mindepth 2 -maxdepth 2 -name .git -exec rm -rf {} +

# Tahap 2: image Odoo + modul OCA + modul KompakApps
FROM odoo:${ODOO_VERSION}
USER root
COPY --from=oca /oca /opt/oca
ENV PIP_BREAK_SYSTEM_PACKAGES=1
# Hanya dependensi Python yang dibutuhkan modul OCA yang kita pakai (lihat docker/requirements.txt).
COPY docker/requirements.txt /tmp/requirements.txt
RUN set -eu; \
    if grep -qv -e '^[[:space:]]*#' -e '^[[:space:]]*$' /tmp/requirements.txt; then \
        pip3 install --no-cache-dir -r /tmp/requirements.txt; \
    fi
COPY config/odoo.conf /etc/odoo/odoo.conf
COPY addons /mnt/extra-addons
COPY docker/entrypoint.sh /usr/local/bin/kompakapps-entrypoint.sh
RUN chmod 755 /usr/local/bin/kompakapps-entrypoint.sh \
    && chown -R odoo:odoo /etc/odoo /mnt/extra-addons
USER odoo
# Menyuntikkan admin_passwd dari ADMIN_PASSWD, lalu meneruskan ke entrypoint bawaan image.
ENTRYPOINT ["/usr/local/bin/kompakapps-entrypoint.sh"]
CMD ["odoo"]
