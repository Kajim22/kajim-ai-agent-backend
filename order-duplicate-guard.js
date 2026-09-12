// Prevent duplicate webhook saves while allowing legitimate later orders from the same chat.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const previousLoader = Module._extensions['.js'];

Module._extensions['.js'] = function repeatedOrderGuardLoader(module, filename) {
  if (path.basename(filename) !== 'server.js') return previousLoader(module, filename);

  let source = fs.readFileSync(filename, 'utf8');

  const helper = `
function orderConfirmationKey(historyArr) {
  const history = historyArr || [];
  const lastUserIndex = history.reduce((index, message, currentIndex) => {
    return message?.role === 'user' ? currentIndex : index;
  }, -1);
  if (lastUserIndex < 0) return '';
  const text = (history[lastUserIndex].parts || []).map(part => part.text || '').join(' ').trim().toLowerCase();
  return String(lastUserIndex) + ':' + text;
}

function canSaveNewConfirmedOrder(store, chatId, historyArr) {
  const key = orderConfirmationKey(historyArr);
  if (!key) return false;
  store.__lastOrderConfirmationKey = store.__lastOrderConfirmationKey || {};
  if (store.__lastOrderConfirmationKey[chatId] === key) return false;
  return true;
}

function markOrderConfirmationSaved(store, chatId, historyArr) {
  const key = orderConfirmationKey(historyArr);
  store.__lastOrderConfirmationKey = store.__lastOrderConfirmationKey || {};
  store.__lastOrderConfirmationKey[chatId] = key;
}
`;

  if (!source.includes('function orderConfirmationKey(historyArr)')) {
    const anchor = 'const telegramBots = {};';
    const position = source.indexOf(anchor);
    if (position >= 0) source = source.slice(0, position) + helper + '\n' + source.slice(position);
  }

  source = source.replace(
    'if (!bot.orderSaved[chatId] && customerConfirmedOrder(bot.histories[chatId])) {',
    'if (canSaveNewConfirmedOrder(bot, chatId, bot.histories[chatId]) && customerConfirmedOrder(bot.histories[chatId])) {'
  );
  source = source.replace(
    'if (saved) bot.orderSaved[chatId] = true;',
    'if (saved) { markOrderConfirmationSaved(bot, chatId, bot.histories[chatId]); bot.orderSaved[chatId] = false; }'
  );

  source = source.replace(
    'if (!page.orderSaved[senderId] && customerConfirmedOrder(page.histories[senderId])) {',
    'if (canSaveNewConfirmedOrder(page, senderId, page.histories[senderId]) && customerConfirmedOrder(page.histories[senderId])) {'
  );
  source = source.replace(
    'if (saved) page.orderSaved[senderId] = true;',
    'if (saved) { markOrderConfirmationSaved(page, senderId, page.histories[senderId]); page.orderSaved[senderId] = false; }'
  );

  return module._compile(source, filename);
};
