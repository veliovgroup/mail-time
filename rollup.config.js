export default {
  input: 'index.js',
  output: {
    file: 'index.cjs',
    format: 'cjs',
    generatedCode: {
      constBindings: true,
    },
  },
  external: ['josk', 'deepmerge'],
};
