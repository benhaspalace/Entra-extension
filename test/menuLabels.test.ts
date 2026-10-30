import { describe, expect, it } from 'vitest';
import {
  accessPackagesLabel,
  customSecurityAttributeLabels,
} from '../src/content/menuLabels';

describe('portal menu labels', () => {
  it.each([
    'Custom security attributes',
    'Benutzerdefinierte Sicherheitsattribute',
    'Attributs de sécurité personnalisés',
    'Atributos de seguridad personalizados',
    'Attributi di sicurezza personalizzati',
    'Aangepaste beveiligingskenmerken',
    'Atributos de segurança personalizados',
    'atributos de segurança personalizados',
    'カスタム セキュリティ属性',
  ])('recognizes the portal label %s', (label) => {
    expect(customSecurityAttributeLabels).toContain(label);
  });

  it.each([
    ['de', 'Zugriffspakete'],
    ['de-DE', 'Zugriffspakete'],
    ['fr-FR', 'Packages d’accès'],
    ['fr-CA', 'Packages d’accès'],
    ['es-ES', 'Paquetes de acceso'],
    ['it-IT', 'Pacchetti di accesso'],
    ['nl-NL', 'Toegangspakketten'],
    ['pt-BR', 'Pacotes de acesso'],
    ['PT-br', 'Pacotes de acesso'],
    ['ja-JP', 'アクセス パッケージ'],
  ])('localizes Access packages for %s', (language, expected) => {
    expect(accessPackagesLabel(language)).toBe(expected);
  });

  it.each(['en', 'en-US', 'hu-HU', '', 'constructor'])(
    'falls back to English for %s',
    (language) => {
      expect(accessPackagesLabel(language)).toBe('Access packages');
    },
  );
});
