module.exports = {
  requestJira: jest.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })),
  invoke: jest.fn(() => Promise.resolve(null)),
};
