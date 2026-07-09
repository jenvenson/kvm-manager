FROM python:3.11-slim
RUN pip install --no-cache-dir websockify novnc && \
    python3 -c "import zipfile; zipfile.ZipFile('/usr/local/lib/python3.11/site-packages/novnc/resources/novnc_server.zip').extractall('/novnc')"
EXPOSE 16080
CMD ["websockify", "0.0.0.0:16080", "--web=/novnc", \
     "--token-plugin=TokenFile", "--token-source=/vnc-tokens/tokens.cfg"]
