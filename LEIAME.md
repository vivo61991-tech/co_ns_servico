# NS Painel · B2C Suporte (v2.8.0)

Painel de NS 5 min por **Dia**, **Semana** e **Mês**, alimentado pelo TXT exportado do Oracle SQL Developer.

## Atualizar os dados para todos
1. Exporte o resultado da consulta como TXT (colunas separadas por **tabulação**, com o cabeçalho na 1ª linha).
2. No repositório do GitHub, substitua o arquivo `data.txt` (mesmo nome, mesma pasta do `index.html`).
3. Quem abrir o app recebe os dados novos. Se o arquivo tiver erro, o app ignora e continua mostrando os últimos dados válidos.

Também dá para importar o TXT direto no app (aba **Dados**). Nesse caso, os dados ficam só naquele aparelho.

## Formato
- **Colunas obrigatórias:** `PERIODO, QUANTIDADE_DIAS, VOLUME, TOTAL_ATENDIDAS, ATE_5_MIN, TIPO_PERIODO, ORDEM`.
- **Colunas opcionais:** `NS_5_MIN, META_NS, STATUS_NS, STATUS_PERIODO`.
- **Colunas novas:** podem entrar em qualquer posição. O app guarda o valor delas e mostra no detalhe de cada período.
- **`ORDEM`:** é o tipo seguido da data de início. O tipo é `1` para mês, `2` para semana e `3` para dia, e a data vem como `AAAAMMDD`. Exemplos: `120261001`, `220261005`, `320261007`.
- **Números:** sem separador de milhar. O decimal pode ser com vírgula ou ponto.

## O que é conferido antes de salvar
- NS = ATE_5_MIN ÷ TOTAL_ATENDIDAS.
- VOLUME ≥ TOTAL ≥ ATE.
- `ORDEM` combina com `TIPO_PERIODO`.
- QUANTIDADE_DIAS combina com `STATUS_PERIODO`.
- Mês e semana batem com a soma dos dias, quando todos os dias do período estão no arquivo.
- Não há linha repetida.
- Período fechado que mudou em relação ao que já estava salvo pede confirmação.
