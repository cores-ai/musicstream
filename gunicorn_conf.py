# Gunicorn configuration for Railway deployment
bind = "0.0.0.0:8080"
# Threads (not sync workers) so a long /live stream cannot block a whole worker.
worker_class = "gthread"
workers = 2
threads = 16
timeout = 150
keepalive = 5
