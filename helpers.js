const debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info.call(console, '[DEBUG] [mail-time]', `${new Date}`, ...args);
  }
};

const logError = (...args) => {
  console.error.call(console, '[ERROR] [mail-time]', `${new Date}`, ...args);
};

export { debug, logError };
