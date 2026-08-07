export function createNonce(): string {
	return crypto.randomUUID().replaceAll('-', '');
}