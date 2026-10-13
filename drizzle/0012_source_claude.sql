-- 비서 메모리를 ChatGPT Custom GPT 대신 Claude Code 세션이 API로 쓰게 됐다.
-- 어느 쪽이 저장했는지 구분하려고 source에 'claude'를 추가한다.
alter type source add value if not exists 'claude';
