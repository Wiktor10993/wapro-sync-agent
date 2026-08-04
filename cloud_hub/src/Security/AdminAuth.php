<?php
declare(strict_types=1);

namespace Hub\Security;

use PDO;
use RuntimeException;

/**
 * Uwierzytelnianie panelu administracyjnego.
 *
 * Sesje trzymamy we własnej tabeli, nie w plikach PHP — hub bywa wdrażany na
 * hostingach współdzielonych, gdzie `session.save_path` jest wspólny dla wielu
 * kont, a to prosta droga do przejęcia sesji.
 *
 * Zabezpieczenia:
 *  - hasła: password_hash() z domyślnym algorytmem (bcrypt/argon2),
 *  - blokada konta po 5 nieudanych próbach na 15 minut,
 *  - token sesji: 32 losowe bajty; w bazie trzymamy jego SHA-256,
 *  - CSRF: token per sesja, weryfikowany przy każdym POST,
 *  - ciasteczko: HttpOnly, SameSite=Lax, Secure gdy HTTPS.
 */
final class AdminAuth
{
    private const COOKIE = 'hub_admin';
    private const SESSION_TTL = 28800;      // 8 h
    private const MAX_FAILED = 5;
    private const LOCK_MINUTES = 15;

    private ?array $user = null;
    private ?array $session = null;

    public function __construct(private PDO $pdo) {}

    // ------------------------------------------------------------------
    // Konta
    // ------------------------------------------------------------------

    public function createUser(string $tenantId, string $login, string $password, string $displayName = ''): int
    {
        $login = strtolower(trim($login));

        if ($login === '' || !preg_match('/^[a-z0-9._@-]{3,64}$/', $login)) {
            throw new RuntimeException('Login: 3–64 znaki, dozwolone a-z 0-9 . _ - @');
        }
        if (strlen($password) < 10) {
            throw new RuntimeException('Hasło musi mieć co najmniej 10 znaków.');
        }

        $stmt = $this->pdo->prepare('SELECT 1 FROM admin_users WHERE login = ?');
        $stmt->execute([$login]);
        if ($stmt->fetchColumn()) {
            throw new RuntimeException("Użytkownik \"{$login}\" już istnieje.");
        }

        $this->pdo->prepare(
            'INSERT INTO admin_users (tenant_id, login, password_hash, display_name) VALUES (?, ?, ?, ?)'
        )->execute([$tenantId, $login, password_hash($password, PASSWORD_DEFAULT), $displayName ?: $login]);

        return (int) $this->pdo->lastInsertId();
    }

    public function changePassword(int $userId, string $newPassword): void
    {
        if (strlen($newPassword) < 10) {
            throw new RuntimeException('Hasło musi mieć co najmniej 10 znaków.');
        }
        $this->pdo->prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?')
                  ->execute([password_hash($newPassword, PASSWORD_DEFAULT), $userId]);
    }

    // ------------------------------------------------------------------
    // Logowanie
    // ------------------------------------------------------------------

    /**
     * @return array{ok:bool, error?:string}
     */
    public function login(string $login, string $password): array
    {
        $login = strtolower(trim($login));

        $stmt = $this->pdo->prepare('SELECT * FROM admin_users WHERE login = ? AND active = 1');
        $stmt->execute([$login]);
        $user = $stmt->fetch();

        if (!$user) {
            // Stały koszt — inaczej czas odpowiedzi zdradza istnienie konta.
            password_verify($password, '$2y$10$usesomesillystringforeedeededeedeeedeeeeeeeeeeeeeeeeeeeee');
            return ['ok' => false, 'error' => 'Nieprawidłowy login lub hasło.'];
        }

        if ($user['locked_until'] && strtotime((string) $user['locked_until']) > time()) {
            $left = (int) ceil((strtotime((string) $user['locked_until']) - time()) / 60);
            return ['ok' => false, 'error' => "Konto zablokowane. Spróbuj ponownie za {$left} min."];
        }

        if (!password_verify($password, (string) $user['password_hash'])) {
            $failed = (int) $user['failed_logins'] + 1;
            $lock = $failed >= self::MAX_FAILED
                ? gmdate('Y-m-d H:i:s', time() + self::LOCK_MINUTES * 60)
                : null;

            $this->pdo->prepare('UPDATE admin_users SET failed_logins = ?, locked_until = ? WHERE id = ?')
                      ->execute([$failed, $lock, $user['id']]);

            return [
                'ok' => false,
                'error' => $lock
                    ? 'Zbyt wiele nieudanych prób. Konto zablokowane na ' . self::LOCK_MINUTES . ' min.'
                    : 'Nieprawidłowy login lub hasło.',
            ];
        }

        // Rehash, gdy zmienił się domyślny algorytm PHP.
        if (password_needs_rehash((string) $user['password_hash'], PASSWORD_DEFAULT)) {
            $this->pdo->prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?')
                      ->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        }

        $this->pdo->prepare(
            "UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?"
        )->execute([$user['id']]);

        $this->startSession((int) $user['id']);

        return ['ok' => true];
    }

    private function startSession(int $userId): void
    {
        $this->pdo->exec("DELETE FROM admin_sessions WHERE expires_at < datetime('now')");

        $token = bin2hex(random_bytes(32));
        $csrf  = bin2hex(random_bytes(32));

        $this->pdo->prepare(
            'INSERT INTO admin_sessions (id, user_id, ip, user_agent, csrf_token, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([
            hash('sha256', $token),
            $userId,
            $_SERVER['REMOTE_ADDR'] ?? null,
            substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
            $csrf,
            gmdate('Y-m-d H:i:s', time() + self::SESSION_TTL),
        ]);

        setcookie(self::COOKIE, $token, [
            'expires'  => time() + self::SESSION_TTL,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => self::isHttps(),
        ]);
    }

    public function logout(): void
    {
        $token = $_COOKIE[self::COOKIE] ?? '';
        if ($token !== '') {
            $this->pdo->prepare('DELETE FROM admin_sessions WHERE id = ?')
                      ->execute([hash('sha256', $token)]);
        }
        setcookie(self::COOKIE, '', ['expires' => time() - 3600, 'path' => '/']);
        $this->user = null;
        $this->session = null;
    }

    // ------------------------------------------------------------------
    // Bieżąca sesja
    // ------------------------------------------------------------------

    /** @return array{id:int,tenant_id:string,login:string,display_name:string}|null */
    public function currentUser(): ?array
    {
        if ($this->user !== null) {
            return $this->user;
        }

        $token = $_COOKIE[self::COOKIE] ?? '';
        if ($token === '') {
            return null;
        }

        $stmt = $this->pdo->prepare(
            "SELECT s.id AS sid, s.csrf_token, u.id, u.tenant_id, u.login, u.display_name, u.role
               FROM admin_sessions s
               JOIN admin_users u ON u.id = s.user_id
              WHERE s.id = ? AND s.expires_at >= datetime('now') AND u.active = 1
              LIMIT 1"
        );
        $stmt->execute([hash('sha256', $token)]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        $this->session = ['id' => $row['sid'], 'csrf' => $row['csrf_token']];
        return $this->user = [
            'id'           => (int) $row['id'],
            'tenant_id'    => (string) $row['tenant_id'],
            'login'        => (string) $row['login'],
            'display_name' => (string) ($row['display_name'] ?? $row['login']),
            'role'         => (string) $row['role'],
        ];
    }

    public function csrfToken(): string
    {
        $this->currentUser();
        return (string) ($this->session['csrf'] ?? '');
    }

    public function verifyCsrf(?string $token): bool
    {
        $expected = $this->csrfToken();
        return $expected !== '' && is_string($token) && hash_equals($expected, $token);
    }

    private static function isHttps(): bool
    {
        return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
            || (int) ($_SERVER['SERVER_PORT'] ?? 80) === 443;
    }
}
