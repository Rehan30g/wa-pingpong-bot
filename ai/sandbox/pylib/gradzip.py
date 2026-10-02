"""Zip berpassword untuk sandbox Grad (modul zipfile bawaan tidak bisa menulis zip terenkripsi).

    import gradzip
    gradzip.make_zip("out/rahasia.zip", ["catatan.txt", "out/qr.png"], password="rahasia123")
    gradzip.make_zip("out/data.zip", {"isi.txt": "teks langsung"}, password="x", method="zipcrypto")

method="aes" (default): AES-256 format WinZip AE-2, dibuka 7-Zip, WinRAR, ZArchiver,
RAR (Android/iOS), macOS Archive Utility tidak bisa. method="zipcrypto": enkripsi lama
yang dibuka Windows Explorer & hampir semua aplikasi, tetapi lemah (mudah dibobol).
"""
import hashlib
import hmac
import os
import struct
import time
import zlib

_ZIPCRYPTO_KEYS = (305419896, 591751049, 878082192)
_CRC_TABLE = [0] * 256
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ 0xEDB88320 if _c & 1 else _c >> 1
    _CRC_TABLE[_i] = _c


def _dos_time(ts):
    t = time.localtime(ts)
    return ((t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2),
            ((max(t.tm_year, 1980) - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday)


def _deflate(data):
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    return comp.compress(data) + comp.flush()


def _zipcrypto(data, password, crc):
    k0, k1, k2 = _ZIPCRYPTO_KEYS

    def update(k0, k1, k2, byte):
        k0 = (k0 >> 8) ^ _CRC_TABLE[(k0 ^ byte) & 0xFF]
        k1 = ((k1 + (k0 & 0xFF)) * 134775813 + 1) & 0xFFFFFFFF
        k2 = (k2 >> 8) ^ _CRC_TABLE[(k2 ^ (k1 >> 24)) & 0xFF]
        return k0, k1, k2

    for byte in password:
        k0, k1, k2 = update(k0, k1, k2, byte)
    header = bytearray(os.urandom(11)) + bytes([(crc >> 24) & 0xFF])
    out = bytearray()
    for byte in bytes(header) + data:
        temp = (k2 | 2) & 0xFFFF
        out.append(byte ^ (((temp * (temp ^ 1)) >> 8) & 0xFF))
        k0, k1, k2 = update(k0, k1, k2, byte)
    return bytes(out)


def _aes256(data, password):
    from Crypto.Cipher import AES
    from Crypto.Hash import SHA1
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Util import Counter

    salt = os.urandom(16)
    # hashlib.pbkdf2_hmac tidak ada di Pyodide (tanpa OpenSSL); pakai pycryptodome.
    derived = PBKDF2(password, salt, dkLen=66, count=1000, hmac_hash_module=SHA1)
    enc_key, auth_key, verifier = derived[:32], derived[32:64], derived[64:66]
    cipher = AES.new(enc_key, AES.MODE_CTR, counter=Counter.new(128, initial_value=1, little_endian=True))
    encrypted = cipher.encrypt(data)
    auth = hmac.new(auth_key, encrypted, hashlib.sha1).digest()[:10]
    return salt + verifier + encrypted + auth


def make_zip(output, files, password, method="aes"):
    """files: daftar path (disimpan dengan nama file saja) atau dict {nama_di_zip: path/bytes/str}."""
    if not password:
        raise ValueError("password wajib diisi")
    if method not in ("aes", "zipcrypto"):
        raise ValueError("method harus 'aes' atau 'zipcrypto'")
    pw = password.encode("utf-8")
    if isinstance(files, dict):
        items = list(files.items())
    else:
        # Bentuk daftar = path file; path yang tidak ada adalah kesalahan, bukan teks.
        missing = [p for p in files if not (isinstance(p, str) and os.path.isfile(p))]
        if missing:
            raise FileNotFoundError(f"file tidak ditemukan: {', '.join(map(str, missing))}")
        items = [(os.path.basename(p), p) for p in files]
    entries = []
    try:
        _write(output, items, pw, method, entries)
    except Exception:
        # Jangan tinggalkan zip setengah jadi di out/ (bisa ikut terkirim).
        if os.path.exists(output):
            os.remove(output)
        raise
    return {"file": output, "files": [e[0].decode("utf-8") for e in entries], "method": method}


def _write(output, items, pw, method, entries):
    with open(output, "wb") as out:
        for name, source in items:
            if isinstance(source, (bytes, bytearray)):
                data, mtime = bytes(source), time.time()
            elif isinstance(source, str) and os.path.isfile(source):
                with open(source, "rb") as handle:
                    data = handle.read()
                mtime = os.path.getmtime(source)
            elif isinstance(source, str):
                data, mtime = source.encode("utf-8"), time.time()
            else:
                raise ValueError(f"sumber tidak dikenal untuk {name}")
            name_bytes = str(name).replace("\\", "/").encode("utf-8")
            crc = zlib.crc32(data) & 0xFFFFFFFF
            compressed = _deflate(data)
            dos_time, dos_date = _dos_time(mtime)
            flags = 0x0001 | 0x0800  # terenkripsi + nama UTF-8
            if method == "aes":
                payload = _aes256(compressed, pw)
                # Extra 0x9901: AE-2 (CRC disetel 0), vendor "AE", kekuatan 3 = AES-256, metode asli 8 (deflate).
                extra = struct.pack("<HHH2sBH", 0x9901, 7, 2, b"AE", 3, 8)
                method_id, stored_crc = 99, 0
            else:
                payload = _zipcrypto(compressed, pw, crc)
                extra, method_id, stored_crc = b"", 8, crc
            offset = out.tell()
            out.write(struct.pack("<IHHHHHIIIHH", 0x04034B50, 51 if method == "aes" else 20, flags, method_id, dos_time, dos_date,
                                  stored_crc, len(payload), len(data), len(name_bytes), len(extra)))
            out.write(name_bytes + extra + payload)
            entries.append((name_bytes, extra, flags, method_id, dos_time, dos_date, stored_crc, len(payload), len(data), offset))
        central_start = out.tell()
        for name_bytes, extra, flags, method_id, dos_time, dos_date, stored_crc, csize, usize, offset in entries:
            version = 51 if method == "aes" else 20
            out.write(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, version, version, flags, method_id, dos_time, dos_date,
                                  stored_crc, csize, usize, len(name_bytes), len(extra), 0, 0, 0, 0, offset))
            out.write(name_bytes + extra)
        central_size = out.tell() - central_start
        out.write(struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), central_size, central_start, 0))
