"""Pobieranie HTTP z timeoutem, limitem łącznego czasu, ponowieniami i widocznym postępem."""
import time
import urllib.error
import urllib.request

CHUNK_BYTES = 1024 * 1024
RETRYABLE_STATUS = (429, 500, 502, 503, 504)


class Fetcher:
    def __init__(self, client_config, log=lambda message: print(message, flush=True)):
        self.cfg = client_config
        self.log = log
        self._last = 0.0

    def _read(self, url, deadline):
        request = urllib.request.Request(url, headers={"User-Agent": self.cfg["userAgent"]})
        chunks, size, reported = [], 0, 0
        with urllib.request.urlopen(request, timeout=self.cfg["timeoutSeconds"]) as response:
            while chunk := response.read(CHUNK_BYTES):
                chunks.append(chunk)
                size += len(chunk)
                if time.monotonic() > deadline:
                    raise TimeoutError(f"przekroczono limit {self.cfg['deadlineSeconds']} s")
                if size - reported >= 10 * CHUNK_BYTES:
                    reported = size
                    self.log(f"  pobrano {size / 1e6:.0f} MB")
        return b"".join(chunks)

    def get(self, url):
        """Timeout dotyczy pojedynczej operacji sieciowej, a deadline całego adresu z ponowieniami."""
        deadline = time.monotonic() + self.cfg["deadlineSeconds"]
        last_error = None
        for attempt in range(1, self.cfg["retries"] + 1):
            wait = self.cfg["requestPauseSeconds"] - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            started = time.monotonic()
            self.log(f"GET {url[:110]} (próba {attempt}/{self.cfg['retries']})")
            try:
                data = self._read(url, deadline)
                self.log(f"  OK {len(data) / 1e6:.1f} MB w {time.monotonic() - started:.1f} s")
                return data
            except urllib.error.HTTPError as error:
                last_error = error
                if error.code not in RETRYABLE_STATUS:
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                last_error = error
            self.log(f"  błąd: {last_error}")
            pause = 2 ** attempt
            if time.monotonic() + pause > deadline:
                break
            time.sleep(pause)
        raise RuntimeError(f"Nie udało się pobrać {url}: {last_error}")
