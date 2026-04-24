FROM python:3.11-slim

WORKDIR /app

# native 依存（fast_stark_crypto などのビルドに必要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Rust（fast_stark_crypto のビルドに必要）
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 3001

CMD ["gunicorn", "--bind", "0.0.0.0:3001", "--workers", "1", "--timeout", "30", "app:app"]
