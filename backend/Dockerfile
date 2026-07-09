FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvirt-dev pkg-config build-essential libvirt-clients \
    && pip install --no-cache-dir libvirt-python=="$(pkg-config --modversion libvirt)" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
