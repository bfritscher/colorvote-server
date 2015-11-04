FROM bfritscher/nodejs-grunt-bower
RUN mkdir -p /colorvote
COPY . /colorvote/
WORKDIR /colorvote
RUN npm install
CMD ["supervisor", "app.js"]