// Portal navigation strings documented in Microsoft's localized UI instructions:
export const customSecurityAttributeLabels: readonly string[] = [
  'Custom security attributes',
  // https://learn.microsoft.com/de-de/entra/fundamentals/custom-security-attributes-add
  'Benutzerdefinierte Sicherheitsattribute',
  // https://learn.microsoft.com/fr-fr/entra/fundamentals/custom-security-attributes-add
  'Attributs de sécurité personnalisés',
  // https://learn.microsoft.com/es-es/entra/fundamentals/custom-security-attributes-add
  'Atributos de seguridad personalizados',
  // https://learn.microsoft.com/it-it/entra/fundamentals/custom-security-attributes-add
  'Attributi di sicurezza personalizzati',
  // https://learn.microsoft.com/nl-nl/entra/fundamentals/custom-security-attributes-add
  'Aangepaste beveiligingskenmerken',
  // https://learn.microsoft.com/pt-br/entra/fundamentals/custom-security-attributes-add
  'Atributos de segurança personalizados',
  'atributos de segurança personalizados',
  // https://learn.microsoft.com/ja-jp/entra/fundamentals/custom-security-attributes-add
  'カスタム セキュリティ属性',
];

const accessPackagesLabels = new Map([
  ['de', 'Zugriffspakete'],
  ['fr', 'Packages d’accès'],
  ['es', 'Paquetes de acceso'],
  ['it', 'Pacchetti di accesso'],
  ['nl', 'Toegangspakketten'],
  ['pt', 'Pacotes de acesso'],
  ['ja', 'アクセス パッケージ'],
]);

export function accessPackagesLabel(language: string): string {
  const primaryLanguage = language.toLowerCase().split('-')[0] ?? '';
  return accessPackagesLabels.get(primaryLanguage) ?? 'Access packages';
}
