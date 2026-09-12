const signed = process.env.TESTO_SIGNED_RELEASE === '1';
if (signed && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD)) throw new Error('正式发布需要 Developer ID 签名证书 CSC_LINK / CSC_KEY_PASSWORD');
if (signed && !(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) && !(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)) throw new Error('正式发布需要 Apple 公证凭证');
module.exports = {
  appId: 'com.testo.workspace', productName: 'Testo',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/src/**/*', 'src/preload/index.cjs', 'dist-ui/**/*', 'dist-preview/**/*', 'package.json'],
  extraResources: [{ from: 'dist-browser-extension', to: 'browser-extension' }],
  extraMetadata: { testoSignedRelease: signed },
  asar: true, npmRebuild: false,
  forceCodeSigning: signed,
  mac: {
    target: ['dmg', 'zip'], category: 'public.app-category.developer-tools',
    ...(signed ? {} : { identity: '-' }),
    hardenedRuntime: signed, notarize: signed,
    entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist',
  },
  publish: [{ provider: 'github', owner: 'evanryuu', repo: 'testo', releaseType: 'draft' }],
  artifactName: 'Testo-${version}-${os}-${arch}.${ext}',
};
