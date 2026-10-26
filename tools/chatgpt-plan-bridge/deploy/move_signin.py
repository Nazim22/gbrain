"""Move the gbrain-local sign-in from the eval user to the bridge user: exclusive, no-follow, reconcilable.
Usage: python3 -I move_signin.py <src_dir> <dst_dir> <src_user> <dst_user>
- Holds the SOURCE refresh.lock (flock, the same lock the eval TokenStore takes) for the whole move, so no refresh can
  race the copy or the wipe; the lock file is opened O_NOFOLLOW and must be a regular file owned by <src_user>.
- Every file is opened O_NOFOLLOW and checked (regular, owner, one link); targets are written to a temp name with
  O_EXCL|O_NOFOLLOW, fsync'd, then renamed. host.json lands first; credentials.json last is the commit marker.
- States (reconciled on every run):
    dst complete, src credentials absent        -> DONE (nothing to do)
    dst complete, src credentials == dst        -> finish: wipe + unlink src credentials
    dst complete, src credentials != dst        -> REFUSE (two different grants; resolve by hand)
    dst partial  (any temp or host.json only)   -> remove our partial files, redo the copy (src must be present)
    dst empty                                   -> copy, verify, wipe src
Exit 0 on DONE; non-zero with a reason otherwise."""
import errno, fcntl, os, pwd, stat, sys

src, dst, src_user, dst_user = sys.argv[1:5]
su, du = pwd.getpwnam(src_user), pwd.getpwnam(dst_user)
FILES = ('host.json', 'credentials.json')  # credentials.json is written LAST: its presence commits the move

def die(msg):
    print(f'move_signin: REFUSE: {msg}'); sys.exit(2)

def check_dir(d, u):
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != u.pw_uid: die(f'{d} is not a real directory owned by {u.pw_name}')

def open_nofollow(path, flags):
    try: return os.open(path, flags | os.O_NOFOLLOW)
    except OSError as e:
        if e.errno == errno.ELOOP: die(f'{path} is a symlink')
        raise

def read_nofollow(path, u):
    try: fd = open_nofollow(path, os.O_RDONLY)
    except FileNotFoundError: return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != u.pw_uid or st.st_nlink != 1: die(f'{path} is not a single-link regular file owned by {u.pw_name}')
        return os.read(fd, 1 << 20)
    finally: os.close(fd)

def unlink_ours(path):
    try: st = os.lstat(path)
    except FileNotFoundError: return
    if stat.S_ISLNK(st.st_mode) or st.st_uid != du.pw_uid: die(f'{path} is not ours to remove')
    os.unlink(path)

def write_atomic(name, data):
    tmp, final = os.path.join(dst, f'.{name}.moving'), os.path.join(dst, name)
    unlink_ours(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try: os.write(fd, data); os.fsync(fd); os.fchown(fd, du.pw_uid, du.pw_gid)
    finally: os.close(fd)
    os.rename(tmp, final)
    dfd = os.open(dst, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(dfd)
    finally: os.close(dfd)

def wipe_src_credentials():
    path = os.path.join(src, 'credentials.json')
    fd = open_nofollow(path, os.O_WRONLY)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != su.pw_uid or st.st_nlink != 1: die('refuse overwrite of the source credentials')
        os.write(fd, b'\0' * st.st_size); os.fsync(fd)
    finally: os.close(fd)
    os.unlink(path)

check_dir(src, su); check_dir(dst, du)
lock_path = os.path.join(src, 'refresh.lock')
lfd = open_nofollow(lock_path, os.O_RDONLY)
try:
    lst = os.fstat(lfd)
    if not stat.S_ISREG(lst.st_mode) or lst.st_uid != su.pw_uid: die('source refresh.lock is not a regular file owned by the source user')
    fcntl.flock(lfd, fcntl.LOCK_EX)  # same lock as the eval TokenStore (flock(1) -x): no refresh can run during the move
    if os.path.lexists(os.path.join(src, 'refresh.pending')): die('a source refresh is pending (refresh.pending present)')
    src_files = {n: read_nofollow(os.path.join(src, n), su) for n in FILES}
    dst_files = {n: read_nofollow(os.path.join(dst, n), du) for n in FILES}
    partial = any(os.path.lexists(os.path.join(dst, f'.{n}.moving')) for n in FILES) or (dst_files['host.json'] is not None) != (dst_files['credentials.json'] is not None)
    if dst_files['credentials.json'] is not None and not partial:
        if src_files['credentials.json'] is None: print('move_signin: DONE (already moved)'); sys.exit(0)
        if src_files['credentials.json'] != dst_files['credentials.json']: die('source and destination hold DIFFERENT credentials')
        wipe_src_credentials(); print('move_signin: DONE (finished an interrupted move: source wiped)'); sys.exit(0)
    if partial:
        if src_files['credentials.json'] is None: die('destination is partial and the source credentials are gone')
        for n in FILES: unlink_ours(os.path.join(dst, f'.{n}.moving')); unlink_ours(os.path.join(dst, n))
    if src_files['credentials.json'] is None or src_files['host.json'] is None: die('source sign-in files missing')
    for n in FILES: write_atomic(n, src_files[n])
    for n in FILES:
        if read_nofollow(os.path.join(dst, n), du) != src_files[n]: die(f'verify failed for {n}')
        if read_nofollow(os.path.join(src, n), su) != src_files[n]: die(f'source {n} changed during the move')
    wipe_src_credentials()
    print('move_signin: DONE (moved)')
finally:
    os.close(lfd)
